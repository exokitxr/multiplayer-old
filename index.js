const http = require('http');
const express = require('express');
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
  const buffer = new Buffer(matrixBuffer.byteLength + Uint32Array.BYTES_PER_ELEMENT*2);
  const uint32Array = new Uint32Array(buffer.buffer, buffer.byteOffset, 2);
  uint32Array[0] = MESSAGE_TYPES.MATRIX;
  uint32Array[1] = id;
  buffer.set(matrixBuffer, Uint32Array.BYTES_PER_ELEMENT*2);
  return buffer;
};
const _makeAudioMessage = (id, audioBuffer) => {
  const buffer = new Buffer(audioBuffer.byteLength + Uint32Array.BYTES_PER_ELEMENT*2);
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
const players = {};

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

const connections = [];

const app = express();
app.get('/', (req, res, next) => {
  console.log('got request', req.method, req.url);

  res.send('Hello, webmr-server!\n');
});
const server = http.createServer(app);
const wss = new ws.Server({server});
wss.on('connection', ws => {
  console.log('player connection');

  let localId = null;

  const _broadcastMessage = (m, self = false) => {
    for (let i = 0; i < connections.length; i++) {
      const c = connections[i];
      if ((self || c !== ws) && c.readyState === ws.OPEN) {
        c.send(m);
      }
    }
  };
  /* const _broadcastMessages = (ms, self = false) => {
    for (let i = 0; i < connections.length; i++) {
      const c = connections[i];
      if ((self || c !== ws) && c.readyState === ws.OPEN) {
        for (let j = 0; j < ms.length; j++) {
          c.send(ms[j]);
        }
      }
    }
  }; */

  ws.on('message', m => {
    if (typeof m === 'string') {
      const j = _jsonParse(m);
      if (j) {
        const {id} = j;
        if (typeof id === 'number') {
          players[id] = new Player(id);
          localId = id;

          _broadcastMessage(JSON.stringify({type: 'playerEnter', id}));

          connections.push(ws);

          console.log('player join', {id});
        } else {
          console.warn('invalid player join message', j);
        }
      } else {
        console.warn('cannot parse player join message', JSON.stringify(m));
      }
    } else {
      if (m.byteLength >= Uint32Array.BYTES_PER_ELEMENT*2) {
        if ((m.byteOffset % 4) !== 0) {
          const m2 = new Buffer(new ArrayBuffer(m.byteLength));
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

          _broadcastMessage(_makeAudioMessage(id, audioBuffer), true);
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
});
server.listen(port, () => {
  console.log(`http://127.0.0.1:${port}`);
});
