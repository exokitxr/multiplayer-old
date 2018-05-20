const http = require('http');
const url = require('url');
const express = require('express');
const bodyParser = require('body-parser');
const bodyParserJson = bodyParser.json();
const expressionsJs = require('expressions-js');
const ws = require('ws');

const port = parseInt(process.env['PORT'], 10) || 9001;
const FPS = 90;
const TICK_RATE = Math.floor(1000 / FPS);

const _jsonParse = s => {
  try {
    return JSON.parse(s);
  } catch (err) {
    return null;
  }
};
const MESSAGE_TYPES = (() => {
  let id = 0;
  return {
    PLAYER_MATRIX: id++,
    AUDIO: id++,
    OBJECT_MATRIX: id++,
  };
})();
const _makePlayerMatrixMessage = (id, matrixBuffer) => {
  const buffer = Buffer.allocUnsafe(matrixBuffer.byteLength + Uint32Array.BYTES_PER_ELEMENT*2);
  const uint32Array = new Uint32Array(buffer.buffer, buffer.byteOffset, 2);
  uint32Array[0] = MESSAGE_TYPES.PLAYER_MATRIX;
  uint32Array[1] = id;
  buffer.set(matrixBuffer, Uint32Array.BYTES_PER_ELEMENT*2);
  return buffer;
};
const _makeObjectMatrixMessage = (id, matrixBuffer) => {
  const buffer = Buffer.allocUnsafe(matrixBuffer.byteLength + Uint32Array.BYTES_PER_ELEMENT*2);
  const uint32Array = new Uint32Array(buffer.buffer, buffer.byteOffset, 2);
  uint32Array[0] = MESSAGE_TYPES.OBJECT_MATRIX;
  uint32Array[1] = id;
  buffer.set(matrixBuffer, Uint32Array.BYTES_PER_ELEMENT*2);
  return buffer;
};
const _makeAudioMessage = (id, audioBuffer) => {
  const buffer = Buffer.allocUnsafe(audioBuffer.byteLength + Uint32Array.BYTES_PER_ELEMENT*2);
  const uint32Array = new Uint32Array(buffer.buffer, buffer.byteOffset, 2);
  uint32Array[0] = MESSAGE_TYPES.AUDIO;
  uint32Array[1] = id;
  buffer.set(audioBuffer, Uint32Array.BYTES_PER_ELEMENT*2);
  return buffer;
};

const numPlayerMatrixElements =
  (3+4) + // hmd
  (1 + (3+4)) * 2 + // gamepads
  (1 + (5*4*(3+3))) * 2; // hands
class Player {
  constructor(id) {
    this.id = id;

    const matrix = new ArrayBuffer(numPlayerMatrixElements*Float32Array.BYTES_PER_ELEMENT);
    matrix.setUint8Array = (() => {
      const uint8Array = new Uint8Array(matrix);
      return newUint8Array => {
        uint8Array.set(newUint8Array);
      };
    })();
    this.matrix = matrix;
  }
}
const numObjectMatrixElements = 3 + 4;
class TrackedObject {
  constructor(id, owner, expression) {
    this.id = id;
    this.owner = owner;
    this.expression = expression ? expressionsJs.parse(expression) : null;

    const matrix = new ArrayBuffer(numObjectMatrixElements*Float32Array.BYTES_PER_ELEMENT);
    matrix.position = new Float32Array(matrix, 0, 3);
    matrix.quaternion = new Float32Array(matrix, 3*Float32Array.BYTES_PER_ELEMENT, 4);
    matrix.setUint8Array = (() => {
      const uint8Array = new Uint8Array(matrix);
      return newUint8Array => {
        uint8Array.set(newUint8Array);
      };
    })();
    this.matrix = matrix;
  }
  setExpression(expression) {
    this.expression = expression ? expressionsJs.parse(expression) : null;
  }
  update() {
    if (this.expression) {
      const result = this.expression.call({
        matrix: [
          this.matrix[0],
          this.matrix[1],
          this.matrix[2],
        ],
      });
      this.matrix.position[0] = result[0];
      this.matrix.position[1] = result[1];
      this.matrix.position[2] = result[2];

      return true;
    } else {
      return false;
    }
  }
}

const app = express();
const servers = [];
app.get('/', (req, res, next) => {
  res.type('text/html');
  res.end(`\
<!doctype html>
<html>
<head></head>
<body>
  <h1>Mutiplayer servers (live)</h1>
  ${servers.map(server => `<a href="/servers/${server.name}" class=server>${'⌨️\xa0/servers/' + server.name}</a><br>`).join('\n')}
  <script>
    window.onload = () => {
      const playerId = Math.floor(Math.random() * 0xFFFFFFFF);

      const serverEls = document.querySelectorAll('.server');
      for (let i = 0; i < serverEls.length; i++) {
        serverEls[i].href += '?id=' + playerId;
      }
    };
  </script>
</body>
</html>
`);
});
app.get('/servers', (req, res, next) => {
  res.json({
    servers,
  });
});
app.get('/servers/:name', (req, res, next) => {
  res.type('text/html');
  res.end(`\
<html>
<head>
<link href="https://fonts.googleapis.com/css?family=Roboto+Mono" rel="stylesheet">
<style>
  * {
    box-sizing: border-box;
  }
  body {
    display: flex;
    margin: 0;
    background-color: #111;
    color: #FFF;
    font-family: 'Roboto Mono', monospace;
    flex-direction: column;
  }
  .header {
    display: flex;
    height: 50px;
    padding: 20px;
    font-size: 20px;
    background-color: #222;
    align-items: center;
  }
  .content {
    padding: 5px;
    font-size: 12px;
    line-height: 1.6;
    flex-grow: 1;
    overflow: hidden;
  }
</style>
</head>
<body>
  <div class=header id=header>Not connected</div>
  <div class=content id=content></div>
  <script>
    const MESSAGE_TYPES = (() => {
      let id = 0;
      return {
        PLAYER_MATRIX: id++,
        AUDIO: id++,
        OBJECT_MATRIX: id++,
      };
    })();

    window.onload = () => {
      const headerEl = document.getElementById('header');
      const contentEl = document.getElementById('content');

      const _writeLog = s => {
        const div = document.createElement('div');
        div.textContent = s;
        contentEl.appendChild(div);
      };

      const lastMessages = {
        playerMatrix: {},
        audio: {},
        objectMatrix: {},
      };

      const ws = new WebSocket(location.href.replace(/^http/, 'ws'));
      ws.binaryType = 'arraybuffer';
      ws.onmessage = e => {
        const {data} = e;

        if (typeof data === 'string') {
          const j = JSON.parse(data);
          const {type} = j;

          switch (type) {
            case 'playerEnter':
            case 'playerLeave':
            case 'objectAdd':
            case 'objectRemove':
            case 'objectSetUpdateExpression':
            case 'sync': {
              _writeLog(JSON.stringify(j));
              break;
            }
            default: {
              console.warn('invalid message type', {type});
              break;
            }
          }
        } else {
          const arrayBuffer = data;
          const uint32Array = new Uint32Array(arrayBuffer, 0, 2);
          const type = uint32Array[0];
          const id = uint32Array[1];

          switch (type) {
            case MESSAGE_TYPES.PLAYER_MATRIX: {
              const lastMatrixMessage = lastMessages.playerMatrix[id];
              const now = Date.now();
              if (lastMatrixMessage === undefined || (now - lastMatrixMessage) >= 2000) {
                _writeLog(JSON.stringify({
                  type: 'playerMatrix',
                  id,
                  position: Array.from(new Float32Array(arrayBuffer, 0 + 2*Uint32Array.BYTES_PER_ELEMENT, 3)),
                  quaternion: Array.from(new Float32Array(arrayBuffer, 0 + 2*Uint32Array.BYTES_PER_ELEMENT + 3*Float32Array.BYTES_PER_ELEMENT, 4)),
                }));

                lastMessages.playerMatrix[id] = now;
              }
              break;
            }
            case MESSAGE_TYPES.AUDIO: {
              const lastAudioMessage = lastMessages.audio[id];
              const now = Date.now();
              if (lastAudioMessage === undefined || (now - lastAudioMessage) >= 2000) {
                _writeLog(JSON.stringify({
                  type: 'audio',
                  id,
                }));

                lastMessages.audio[id] = now;
              }
              break;
            }
            case MESSAGE_TYPES.OBJECT_MATRIX: {
              const lastMatrixMessage = lastMessages.objectMatrix[id];
              const now = Date.now();
              if (lastMatrixMessage === undefined || (now - lastMatrixMessage) >= 2000) {
                _writeLog(JSON.stringify({
                  type: 'objectMatrix',
                  id,
                  position: Array.from(new Float32Array(arrayBuffer, 0 + 2*Uint32Array.BYTES_PER_ELEMENT, 3)),
                  quaternion: Array.from(new Float32Array(arrayBuffer, 0 + 2*Uint32Array.BYTES_PER_ELEMENT + 3*Float32Array.BYTES_PER_ELEMENT, 4)),
                }));

                lastMessages.objectMatrix[id] = now;
              }
              break;
            }
            default: {
              console.log('got unknown binary message type', {type});
              break;
            }
          }
        }
      };
      ws.onopen = () => {
        headerEl.style.backgroundColor = '#4CAF50';
        headerEl.textContent = 'Connected';
      };
      ws.onclose = () => {
        headerEl.style.backgroundColor = '#F44336';
        headerEl.textContent = 'Not connected';
      };
    };
  </script>
</body>
</html>
`);
});
app.post('/servers/:name', (req, res, next) => {
  const {name} = req.params;

  if (!servers.some(server => server.name === name)) {
    _startServer(name);

    res.json({
      name,
    });
  } else {
    res.status(409);
    res.end(http.STATUS_CODES[409]);
  }
});
app.delete('/servers/:name', (req, res, next) => {
  const {name} = req.params;
  const server = _stopServer(name);
  if (server) {
    const {name} = server;
    res.json({
      name,
    });
  } else {
    res.status(404);
    res.end(http.STATUS_CODES[404]);
  }
});
const server = http.createServer(app);
const wss = new ws.Server({server});
const connectionListeners = [];
wss.on('connection', (ws, req) => {
  for (let i = 0; i < connectionListeners.length; i++) {
    if (connectionListeners[i](ws, req)) {
      return;
    }
  }
  console.log('close');
  ws.close();
});
const _startServer = name => {
  const serverUrl = '/servers/' + name;

  const players = {};
  const objects = {};
  const connections = [];

  const _getWorldSnapshot = () => {
    const result = [];
    for (const id in players) {
      const player = players[id];
      if (player) {
        const {id} = player;
        result.push(JSON.stringify({type: 'playerEnter', id}));
        result.push(_makePlayerMatrixMessage(id, player.matrix));
      }
    }
    for (const id in objects) {
      const object = objects[id];
      if (object) {
        const {id} = object;
        result.push(JSON.stringify({type: 'objectAdd', id}));
        result.push(_makeObjectMatrixMessage(id, object.matrix));
      }
    }
    result.push(JSON.stringify({type: 'sync'}));
    return result;
  };

  const _onconnection = (ws, req) => {
    const parsedUrl = url.parse(req.url, {
      parseQueryString: true,
    });

    let localId = parseInt(parsedUrl.query.id, 10);
    if (parsedUrl.pathname === serverUrl && !isNaN(localId)) {
      console.log('connection', parsedUrl.pathname, parsedUrl.query.id);

      const _broadcastMessage = (m, self = false) => {
        for (let i = 0; i < connections.length; i++) {
          const c = connections[i];
          if ((self || c !== ws) && c.readyState === ws.OPEN) {
            c.send(m);
          }
        }
      };
      ws.broadcastMessage = _broadcastMessage;

      ws.on('message', m => {
        if (typeof m === 'string') {
          const j = _jsonParse(m);

          if (j) {
            const {type} = j;

            switch (type) {
              case 'playerEnter': {
                players[localId] = new Player(localId);

                _broadcastMessage(JSON.stringify({type: 'playerEnter', id: localId}));
                break;
              }
              case 'objectAdd': {
                const {id, owner = -1, expression = null} = j;

                if (!objects[id]) {
                  objects[id] = new TrackedObject(id, owner, expression);

                  _broadcastMessage(JSON.stringify({type: 'objectAdd', id, owner}));
                  break;
                }
              }
              case 'objectRemove': {
                const {id} = j;

                const object = objects[id];
                if (object) {
                  objects[id] = null;

                  _broadcastMessage(JSON.stringify({type: 'objectRemove', id}));
                  break;
                }
              }
              case 'objectSetUpdateExpression': {
                const {id, expression} = j;

                const object = objects[id];
                if (object) {
                  object.setExpression(expression);
                } else {
                  console.warn('object set update expression fr nonexistent object', {id, expression});
                }
                break;
              }
              default: {
                console.warn('invalid player message type', JSON.stringify(type));
                break;
              }
            }
          } else {
            console.warn('cannot parse player message', JSON.stringify(m));
          }
        } else {
          if (m.byteLength >= Uint32Array.BYTES_PER_ELEMENT*2) {
            if ((m.byteOffset % 4) !== 0) {
              const m2 = Buffer.from(new ArrayBuffer(m.byteLength));
              m2.set(m);
              m = m2;
            }
            const type = new Uint32Array(m.buffer, m.byteOffset + 0, 1)[0];
            const id = new Uint32Array(m.buffer, m.byteOffset + Uint32Array.BYTES_PER_ELEMENT, 1)[0];

            switch (type) {
              case MESSAGE_TYPES.PLAYER_MATRIX: {
                const player = players[id];

                if (player) {
                  const matrixBuffer = m.slice(Uint32Array.BYTES_PER_ELEMENT*2);
                  player.matrix.setUint8Array(matrixBuffer);

                  _broadcastMessage(_makePlayerMatrixMessage(id, matrixBuffer));
                } else {
                  console.warn('ignoring player matrix message for unknown player', {id});
                }
                break;
              }
              case MESSAGE_TYPES.AUDIO: {
                const player = players[id];

                if (player) {
                  const audioBuffer = m.slice(Uint32Array.BYTES_PER_ELEMENT*2);

                  _broadcastMessage(_makeAudioMessage(id, audioBuffer));
                } else {
                  console.warn('ignoring player audio message for unknown player', {id});
                }
                break;
              }
              case MESSAGE_TYPES.OBJECT_MATRIX: {
                const object = objects[id];

                if (object) {
                  const object = objects[id];
                  const matrixBuffer = m.slice(Uint32Array.BYTES_PER_ELEMENT*2);
                  object.matrix.setUint8Array(matrixBuffer);

                  console.log('broadcast object', id);

                  _broadcastMessage(_makeObjectMatrixMessage(id, matrixBuffer));
                } else {
                  console.warn('ignoring object matrix message for unknown object', {id});
                }
                break;
              }
            }
          } else {
            console.warn('invalid player binary message', m.byteLength);
          }
        }
      });
      ws.on('close', () => {
        if (localId) {
          const id = localId;
          const player = players[id];

          if (player) {
            _broadcastMessage(JSON.stringify({type: 'playerLeave', id}));

            players[id] = null;
          }
          connections.splice(connections.indexOf(ws), 1);

          console.log('disconnect', {id});
        }
      });

      const worldSnapshot = _getWorldSnapshot();
      for (let i = 0; i < worldSnapshot.length; i++) {
        ws.send(worldSnapshot[i]);
      }

      connections.push(ws);

      return true;
    } else {
      return false;
    }
  };
  connectionListeners.push(_onconnection);

  const interval = setInterval(() => {
    for (const id in objects) {
      const object = objects[id];

      if (object && object.update()) {
        for (let i = 0; i < connections.length; i++) {
          const b = _makeObjectMatrixMessage(id, Buffer.from(object.matrix));

          connections[i].broadcastMessage(_makeObjectMatrixMessage(id, Buffer.from(object.matrix)), true);
        }
      }
    }
  }, TICK_RATE);

  servers.push({
    name,
    kill: () => {
      connectionListeners.splice(connectionListeners.indexOf(_onconnection), 1);
      clearInterval(inverval);
    },
  });
};
const _stopServer = name => {
  const index = servers.findIndex(server => server.name === name);
  if (index !== -1) {
    const server = servers[index];
    server.kill();
    servers.splice(index, 1);
    return server;
  } else {
    return null;
  }
};
_startServer('root');
server.listen(port, () => {
  console.log(`ws://127.0.0.1:${port}/`);
});
