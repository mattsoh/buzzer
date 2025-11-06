const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// In-memory state
// playersById: playerId -> { socketId, name, approved, lastBuzzTime, points }
const playersById = {};
// map socketId -> playerId for quick lookup
const socketToPlayer = {};
let currentQuestion = '';
let startTime = null; // epoch ms when buzzing opens
let isBuzzingActive = false;
let winnerId = null;
let buzzOrder = []; // [{ id, time }] ordered by time for the round
let buzzCutoff = null; // epoch ms after which no more buzzes accepted

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'letmein'; // use env var for deployments

app.use(express.static(path.join(__dirname, 'public')));

// Redirect root to player page for easy access
app.get('/', (req, res) => {
  res.redirect('/player.html');
});

// admin tokens to allow reauth across refresh
const adminTokens = new Set();

function sendAdminPlayerList() {
  const list = Object.entries(playersById).map(([id, p]) => ({ id, name: p.name, approved: !!p.approved, points: p.points || 0 }));
  io.to('admins').emit('admin:playerList', { players: list, currentQuestion, isBuzzingActive, winnerId, buzzOrder });
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('admin:auth', (pwd) => {
    if (pwd === ADMIN_PASSWORD) {
      socket.join('admins');
      // issue a token so admin can refresh and rejoin without password
      const token = `${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
      adminTokens.add(token);
      socket.emit('admin:auth:ok', { token });
      // Send current state
      sendAdminPlayerList();
    } else {
      socket.emit('admin:auth:fail');
    }
  });

  socket.on('admin:authToken', (token) => {
    if (adminTokens.has(token)) {
      socket.join('admins');
      socket.emit('admin:auth:ok', { token });
      sendAdminPlayerList();
    } else {
      socket.emit('admin:auth:fail');
    }
  });

  socket.on('player:join', (name) => {
    const pid = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    playersById[pid] = { socketId: socket.id, name: name || 'Anonymous', approved: false, lastBuzzTime: null, points: 0 };
    socketToPlayer[socket.id] = pid;
    // tell client their playerId so they can persist it
    socket.emit('player:joined', { id: pid });
    // notify admins of join request
    io.to('admins').emit('admin:playerRequest', { id: pid, name: playersById[pid].name });
    sendAdminPlayerList();
  });

  socket.on('player:reconnect', ({ id: pid }) => {
    if (playersById[pid]) {
      playersById[pid].socketId = socket.id;
      socketToPlayer[socket.id] = pid;
      // confirm reconnection
      socket.emit('player:reconnected', { id: pid, approved: !!playersById[pid].approved });
      // if approved, notify the player
      if (playersById[pid].approved) socket.emit('player:approved');
      // if a round is active, tell them the round state
      if (isBuzzingActive && startTime) {
        socket.emit('round:starting', { question: currentQuestion, startTime });
      }
      sendAdminPlayerList();
    }
  });

  socket.on('admin:approve', ({ id }) => {
    if (playersById[id]) {
      playersById[id].approved = true;
      const sid = playersById[id].socketId;
      if (sid) io.to(sid).emit('player:approved');
      sendAdminPlayerList();
    }
  });

  socket.on('admin:kick', ({ id }) => {
    if (playersById[id]) {
      const sid = playersById[id].socketId;
      if (sid) io.to(sid).emit('player:kicked');
      // remove from buzzOrder if present
      buzzOrder = buzzOrder.filter(b => b.id !== id);
      // remove mapping
      if (sid) delete socketToPlayer[sid];
      delete playersById[id];
      sendAdminPlayerList();
    }
  });

  socket.on('admin:start', ({ question }) => {
    currentQuestion = question || '';
    // reset per-round data
  Object.keys(playersById).forEach((id) => { playersById[id].lastBuzzTime = null; });
    winnerId = null;
    buzzOrder = [];
    buzzCutoff = null;
  // schedule start a bit in the future to sync clients
  startTime = Date.now() + 2000; // 2s in future
    isBuzzingActive = true;
    io.emit('round:starting', { question: currentQuestion, startTime });
    sendAdminPlayerList();
  });

  socket.on('player:buzz', () => {
    const pid = socketToPlayer[socket.id];
    if (!pid) return;
    const p = playersById[pid];
    if (!p) return;
    if (!p.approved) return;
    const buzzTime = Date.now();
    // Only accept buzzes at or after startTime
    if (!startTime || buzzTime < startTime) return;

    // If no winner yet, this is the first buzz
    if (!winnerId) {
      winnerId = pid;
      playersById[pid].lastBuzzTime = buzzTime;
      // set cutoff to allow others to buzz up to 2s after this first buzz
      buzzCutoff = buzzTime + 2000;
      // record first in buzzOrder
      buzzOrder.push({ id: pid, time: buzzTime - startTime });

      // Allow others to buzz until buzzCutoff; schedule finalization
      setTimeout(() => {
        finalizeRound();
      }, Math.max(0, buzzCutoff - Date.now()));

      sendAdminPlayerList();
    } else {
      // If within the 1s window and this player hasn't already buzzed, record it
      if (buzzCutoff && buzzTime <= buzzCutoff) {
        // avoid duplicate entries
        const already = buzzOrder.find(b => b.id === pid);
        if (!already) {
          playersById[pid].lastBuzzTime = buzzTime;
          buzzOrder.push({ id: pid, time: buzzTime - startTime });
          sendAdminPlayerList();
        }
      }
      // else ignore late buzzes
    }
  });

  function finalizeRound(){
    isBuzzingActive = false;
    // sort buzzOrder by time (already in order but ensure)
    buzzOrder.sort((a,b)=>a.time - b.time);

    // compute per-player times relative to startTime
    // initialize all to null, then fill using buzzOrder to ensure consistency
    const perPlayer = {};
    Object.keys(playersById).forEach(id => { perPlayer[id] = null; });
    buzzOrder.forEach(b => { perPlayer[b.id] = b.time; });

    if (buzzOrder.length > 0) {
      const winner = buzzOrder[0].id;
      // award a point to the winner
      if (playersById[winner]) playersById[winner].points = (playersById[winner].points || 0) + 1;
      winnerId = winner;
    }

    io.emit('round:ended', {
      winnerId,
      winnerName: winnerId ? playersById[winnerId].name : null,
      winnerTime: buzzOrder.length>0 ? buzzOrder[0].time : null,
      times: perPlayer,
      buzzOrder,
    });
    sendAdminPlayerList();
  }

  socket.on('admin:next', () => {
    // reset state for next question
    currentQuestion = '';
    startTime = null;
    isBuzzingActive = false;
    winnerId = null;
    Object.keys(playersById).forEach((id) => { playersById[id].lastBuzzTime = null; });
    io.emit('round:reset');
    sendAdminPlayerList();
  });

  socket.on('disconnect', () => {
    // if this socket was associated with a player, clear the socket mapping but keep player data
    const pid = socketToPlayer[socket.id];
    if (pid && playersById[pid]) {
      // clear stored socket id
      playersById[pid].socketId = null;
      delete socketToPlayer[socket.id];
      io.to('admins').emit('admin:playerLeft', { id: pid });
      sendAdminPlayerList();
    }
    // if admin disconnected, we keep adminTokens so they can reconnect with token
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
