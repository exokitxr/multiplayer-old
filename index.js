const http = require('http');
const url = require('url');
const express = require('express');
const bodyParser = require('body-parser');
const bodyParserJson = bodyParser.json();
const ws = require('ws');

const port = parseInt(process.env['PORT'], 10) || 9001;

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
    MATRIX: id++,
    AUDIO: id++,
  };
})();
const _makeMatrixMessage = (id, matrixBuffer) => {
  const buffer = Buffer.from(matrixBuffer.byteLength + Uint32Array.BYTES_PER_ELEMENT*2);
  const uint32Array = new Uint32Array(buffer.buffer, buffer.byteOffset, 2);
  uint32Array[0] = MESSAGE_TYPES.MATRIX;
  uint32Array[1] = id;
  buffer.set(matrixBuffer, Uint32Array.BYTES_PER_ELEMENT*2);
  return buffer;
};
const _makeAudioMessage = (id, audioBuffer) => {
  const buffer = Buffer.from(audioBuffer.byteLength + Uint32Array.BYTES_PER_ELEMENT*2);
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
    flex-grow: 1;
  }
</style>
</head>
<body>
  <div class=header id=header>Not connected</div>
  <div class=content id=content></div>
  <script>
    window.onload = () => {
      const headerEl = document.getElementById('header');
      const contentEl = document.getElementById('content');

      const ws = new WebSocket(location.href.replace(/^http:/, 'ws:'));
      ws.binaryType = 'arraybuffer';
      ws.onmessage = e => {
        const {data} = e;
        if (typeof data === 'string') {
          const j = JSON.parse(data);
          console.log('got json', j);
        } else {
          const b = data;
          console.log('got buffer', b);
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
      console.log('matched');
      return;
    }
  }
  console.log('close');
  ws.close();
});
const _startServer = name => {
  const serverUrl = '/servers/' + name;

  const players = {};
  const connections = [];

  const _getWorldSnapshot = () => {
    const result = [];
    for (const id in players) {
      const player = players[id];
      if (player) {
        const {id} = player;
        result.push(JSON.stringify({type: 'playerEnter', id}));
        result.push(_makeMatrixMessage(id, player.matrix));
      }
    }
    return result;
  };

  const _onconnection = (ws, req) => {
    const parsedUrl = url.parse(req.url, {
      parseQueryString: true,
    });

    let localId = parseInt(parsedUrl.query.id, 10);
    if (parsedUrl.pathname === serverUrl && !isNaN(localId)) {
      console.log('player connection', parsedUrl.pathname, parsedUrl.query.id);

      const _broadcastMessage = (m, self = false) => {
        for (let i = 0; i < connections.length; i++) {
          const c = connections[i];
          if ((self || c !== ws) && c.readyState === ws.OPEN) {
            c.send(m);
          }
        }
      };

      ws.on('message', m => {
        if (typeof m === 'string') {
          const j = _jsonParse(m);

          if (j) {
            const {type} = j;

            switch (type) {
              case 'playerEnter': {
                players[localId] = new Player(localId);

                _broadcastMessage(JSON.stringify({type: 'playerEnter', id: localId}));

                connections.push(ws);
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

            if (type === MESSAGE_TYPES.MATRIX) {
              const player = players[id];
              const matrixBuffer = m.slice(Uint32Array.BYTES_PER_ELEMENT*2);
              player.matrix.setUint8Array(matrixBuffer);

              _broadcastMessage(_makeMatrixMessage(id, matrixBuffer));
            } else if (type === MESSAGE_TYPES.AUDIO) {
              const audioBuffer = m.slice(Uint32Array.BYTES_PER_ELEMENT*2);

              _broadcastMessage(_makeAudioMessage(id, audioBuffer));
            } else {
              console.warn('invalid player binary message type', type);
            }
          } else {
            console.warn('invalid player binary message', m.byteLength);
          }
        }
      });
      ws.on('close', () => {
        if (localId) {
          const id = localId;
          players[id] = null;

          _broadcastMessage(JSON.stringify({type: 'playerLeave', id}));

          connections.splice(connections.indexOf(ws), 1);

          console.log('player leave', {id});
        }
      });

      const worldSnapshot = _getWorldSnapshot();
      for (let i = 0; i < worldSnapshot.length; i++) {
        ws.send(worldSnapshot[i]);
      }

      return true;
    } else {
      return false;
    }
  };
  connectionListeners.push(_onconnection);

  servers.push({
    name,
    kill: () => {
      connectionListeners.splice(connectionListeners.indexOf(_onconnection), 1);
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
