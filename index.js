const http = require('http');
const express = require('express');
const ws = require('ws');

const port = parseInt(process.env['PORT'], 10) || 9000;

const numPlayerMatrixElements =
  (3+4) + // hmd
  (1 + (3+4)) * 2 + // gamepads
  (1 + (5*4*(3+3))) * 2; // hands
class Player {
  constructor(id) {
    this.id = id;

    const matrix = new ArrayBuffer(numPlayerMatrixElements * Float32Array.BYTES_PER_ELEMENT);
    matrix.setUint8Array = (() => {
      const uint8Array = new Uint8Array(matrix);
      return newUint8Array => {
        uint8Array.set(newUint8Array);
      };
    })();
    this.matrix = matrix;
  }
}
const playerList = {};

const _getWorldSnapshot = () => {
  const result = [];
  for (const id in playerList) {
    const player = playerList[id];
    if (player) {
      const {id} = player;
      result.push(JSON.stringify({type: 'playerEnter', id}));
      result.push(JSON.stringify({type: 'setContext', id}));
      result.push(player.matrix);
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
  let localId = null;

  const _broadcastMessage = m => {
    for (let i = 0; i < connections.length; i++) {
      const c = connections[i];
      if (c !== ws && c.readyState === ws.OPEN) {
        c.send(m);
      }
    }
  };
  const _broadcastMessages = ms => {
    for (let i = 0; i < connections.length; i++) {
      const c = connections[i];
      if (c !== ws && c.readyState === ws.OPEN) {
        for (let j = 0; j < ms.length; j++) {
          c.send(ms[j]);
        }
      }
    }
  };

  ws.on('message', m => {
    if (typeof m === 'string') {
      const j = JSON.parse(m);
      const {id} = j;
      playerList[id] = new Player(id);
      localId = id;

      _broadcastMessage(JSON.stringify({type: 'playerEnter', id}));

      connections.push(ws);

      console.log('player join', {id});
    } else {
      if (localId) {
        const player = playerList[localId];

        player.matrix.setUint8Array(m);

        _broadcastMessages([
          JSON.stringify({type: 'setContext', id: player.id}),
          player.matrix,
        ]);
      } else {
        console.warn('got positional message for null player id');
      }
    }
  });
  ws.on('close', () => {
    if (localId) {
      const id = localId;
      playerList[id] = null;

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
server.listen(port);
