const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { GameRoom, randomCode } = require('./game-room');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { connectionStateRecovery: { maxDisconnectionDuration: 120_000, skipMiddlewares: true } });
const rooms = new Map();
const PORT = process.env.PORT || 7000;
const configuredPublicGameUrl = String(process.env.PUBLIC_GAME_URL || '').trim().replace(/\/$/, '');

function publicGameUrlFor(request) {
  if (configuredPublicGameUrl) return configuredPublicGameUrl;
  const protocol = String(request.get('x-forwarded-proto') || request.protocol).split(',')[0].trim();
  const host = String(request.get('x-forwarded-host') || request.get('host')).split(',')[0].trim();
  return `${protocol}://${host}`.replace(/\/$/, '');
}

app.get('/room/:roomCode', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.get('/runtime-config.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(`window.GAME_CONFIG = ${JSON.stringify({ publicGameUrl: publicGameUrlFor(req) })};`);
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

function emitRoom(room) {
  for (const player of room.players.values()) {
    io.to(player.id).emit('room-state', room.getStateFor(player.id));
  }
}

function findRoom(code) {
  return rooms.get(String(code || '').trim().toUpperCase());
}

function sendError(socket, error) {
  socket.emit('game-error', error instanceof Error ? error.message : String(error));
}

function removeSocketFromRoom(socket) {
  const code = socket.data.roomCode;
  const room = findRoom(code);
  if (!room) return;
  room.removePlayer(socket.id);
  socket.leave(room.code);
  socket.data.roomCode = null;
  if (room.players.size === 0) rooms.delete(room.code);
  else emitRoom(room);
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ name, avatar }) => {
    try {
      removeSocketFromRoom(socket);
      let code;
      do code = randomCode(); while (rooms.has(code));
      const room = new GameRoom(code, socket.id);
      room.onChange = () => emitRoom(room);
      room.addPlayer(socket.id, name, avatar);
      rooms.set(code, room);
      socket.join(code);
      socket.data.roomCode = code;
      emitRoom(room);
    } catch (error) { sendError(socket, error); }
  });

  socket.on('join-room', ({ code, name, avatar }) => {
    try {
      const room = findRoom(code);
      if (!room) throw new Error('Room not found. Check the code and try again.');
      if (socket.data.roomCode && socket.data.roomCode !== room.code) removeSocketFromRoom(socket);
      room.addPlayer(socket.id, name, avatar);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      emitRoom(room);
    } catch (error) { sendError(socket, error); }
  });

  const roomAction = (event, action) => {
    socket.on(event, (payload) => {
      try {
        const room = findRoom(socket.data.roomCode);
        if (!room) throw new Error('Your room is no longer available.');
        room.touchPlayer(socket.id);
        action(room, payload || {});
        emitRoom(room);
      } catch (error) { sendError(socket, error); }
    });
  };

  socket.on('room-state-request', () => {
    const room = findRoom(socket.data.roomCode);
    if (room && room.players.has(socket.id)) socket.emit('room-state', room.getStateFor(socket.id));
  });

  roomAction('start-game', (room) => room.startGame());
  roomAction('choose-game', (room, { gameMode }) => room.chooseGame(socket.id, gameMode));
  roomAction('set-game-settings', (room, settings) => room.setGameSettings(socket.id, settings));
  roomAction('remove-player', (room, { playerId }) => room.removePlayerByHost(socket.id, playerId));
  roomAction('voice-state', (room, { muted }) => room.setVoiceState(socket.id, muted));
  roomAction('set-word-settings', (room, settings) => room.setWordSettings(socket.id, settings));
  roomAction('add-word', (room, { word }) => room.addWord(socket.id, word));
  roomAction('edit-word', (room, { wordId, word }) => room.editWord(socket.id, wordId, word));
  roomAction('delete-word', (room, { wordId }) => room.deleteWord(socket.id, wordId));
  roomAction('clear-words', (room) => room.clearWords(socket.id));
  roomAction('submit-thought', (room, { answer }) => room.submitThought(socket.id, answer));
  roomAction('submit-clues', (room, { clues }) => room.submitClues(socket.id, clues));
  roomAction('submit-drawing', (room, { image }) => room.submitDrawing(socket.id, image));
  roomAction('submit-guess', (room, { guess }) => room.submitGuess(socket.id, guess));
  roomAction('react-drawing', (room, { number, reaction }) => room.reactToDrawing(socket.id, number, reaction));
  roomAction('submit-who-vote', (room, { targetId }) => room.submitWhoVote(socket.id, targetId));
  roomAction('resolve-who-tie', (room, { targetId }) => room.resolveWhoTie(socket.id, targetId));
  roomAction('next-who-question', (room) => room.nextWhoQuestion(socket.id));
  roomAction('play-another-game', (room, { gameMode }) => room.restartSelectedGame(socket.id, gameMode));
  roomAction('choose-drawing', (room, { number, funny }) => room.chooseDrawing(socket.id, number, funny));
  roomAction('next-round', (room) => room.nextRound(socket.id));
  roomAction('end-game', (room) => room.endGame(socket.id));

  socket.on('leave-room', () => removeSocketFromRoom(socket));

  const relayVoiceSignal = (event) => socket.on(event, ({ to, ...payload } = {}) => {
    const room = findRoom(socket.data.roomCode);
    if (!room || !room.players.has(to) || !room.players.has(socket.id)) return;
    io.to(to).emit(event, { from: socket.id, ...payload });
  });
  relayVoiceSignal('voice-offer');
  relayVoiceSignal('voice-answer');
  relayVoiceSignal('voice-ice');

  socket.on('disconnect', () => {
    removeSocketFromRoom(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Draw What I'm Thinking server ready on port ${PORT}`);
});
