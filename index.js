const http = require('http');
const express = require('express');
const ws = require('ws');

const playerMatrixSize = 3 + 4;
class Player {
  constructor(id) {
    this.id = id;
    this.matrix = new Float32Array(new ArrayBuffer(playerMatrixSize * Float32Array.BYTES_PER_ELEMENT), 0, playerMatrixSize);
  }
}
const playerList = {};

const _getWorldSnapshot = () => {
  const result = [];
  for (const id in playerList) {
    const player = playerList[id];
    if (player) {
      const {id} = player;
      result.push({type: 'playerEnter', id});
      result.push({type: 'setContext', id});
      result.push(player.matrix);
    }
  }
  return result;
};

const connections = [];

const app = express();
const server = http.createServer(app);
const wss = new ws.Server({server});
wss.on('connection', ws => {
  let localId = null;

  const _broadcastMessage = m => {
    for (let i = 0; i < connections.length; i++) {
      const c = connections[i];
      if (c !== ws) {
        c.send(m);
      }
    }
  };
  const _broadcastMessages = ms => {
    for (let i = 0; i < connections.length; i++) {
      const c = connections[i];
      if (c !== ws) {
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

      _broadcastMessage({type: 'playerEnter', id});

      connections.push(ws);

      console.log('player join', {id});
    } else {
      if (localId) {
        const player = playerList[localId];

        const arrayBuffer = new ArrayBuffer(m.length);
        new Uint8Array(arrayBuffer).set(m);
        const position = new Float32Array(arrayBuffer, 0, 3);
        player.matrix.set(position, 0);
        const quaternion = new Float32Array(arrayBuffer, 3 * Float32Array.BYTES_PER_ELEMENT, 4);
        player.matrix.set(quaternion, 3);

        _broadcastMessages([
          player.id,
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

      _broadcastMessage({type: 'playerLeave', id});

      connections.splice(connections.indexOf(ws), 1);

      console.log('player leave', {id});
    }
  });

  const worldSnapshot = _getWorldSnapshot();
  for (let i = 0; i < worldSnapshot.length; i++) {
    ws.send(worldSnapshot[i]);
  }
});
server.listen(9000);
