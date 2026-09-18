const test = require('node:test');
const assert = require('node:assert/strict');
const { GameRoom } = require('../server/game-room');

const drawing = 'data:image/png;base64,iVBORw0KGgo=';

function makeRoom(playerCount) {
  const room = new GameRoom(`R${playerCount}`, 'p1');
  for (let index = 1; index <= playerCount; index += 1) room.addPlayer(`p${index}`, `Player ${index}`, '😀');
  return room;
}

test('supports variable player counts and rotates the thinker', () => {
  for (const count of [2, 3, 4, 5, 6, 7, 8, 12]) {
    const room = makeRoom(count);
    room.setGameSettings('p1', { rounds: count, clueCount: 1, winnerPoints: 120, thinkerPoints: 30, funniestEnabled: false });
    room.startGame();
    const thinkers = [];
    for (let round = 1; round <= count; round += 1) {
      const thinker = room.thinkerId;
      thinkers.push(thinker);
      room.submitThought(thinker, room.secretAnswer);
      room.submitClues(thinker, ['clue']);
      for (const id of room.players.keys()) if (id !== thinker) room.submitDrawing(id, drawing);
      room.chooseDrawing(thinker, 1, true);
      const winnerId = room.winnerId;
      assert.equal(room.players.get(winnerId).score, 120);
      room.stopTimer();
      if (round < count) room.nextRound('p1');
    }
    assert.equal(new Set(thinkers).size, count);
    room.stopTimer();
  }
});

test('keeps the selected secret answer private', () => {
  const room = makeRoom(4);
  room.startGame();
  const thinker = room.thinkerId;
  const nonThinker = [...room.players.keys()].find((id) => id !== thinker);
  assert.ok(room.getStateFor(thinker).secretAnswer);
  assert.equal(room.getStateFor(nonThinker).secretAnswer, '');
  room.stopTimer();
});

test('enforces host settings and configured clue count', () => {
  const room = makeRoom(2);
  assert.throws(() => room.setGameSettings('p2', { minPlayers: 3 }), /Only the host/);
  room.setGameSettings('p1', { minPlayers: 2, clueCount: 2, drawingTime: 30, rounds: 1 });
  room.startGame();
  const thinker = room.thinkerId;
  room.submitThought(thinker, room.secretAnswer);
  assert.throws(() => room.submitClues(thinker, ['one']), /exactly 2/);
  room.submitClues(thinker, ['one', 'two']);
  assert.equal(room.phase, 'drawing');
  assert.equal(room.deadline > Date.now(), true);
  room.stopTimer();
});

test('rejects duplicate drawings and malicious drawing payloads', () => {
  const room = makeRoom(2);
  room.startGame();
  const thinker = room.thinkerId;
  const artist = [...room.players.keys()].find((id) => id !== thinker);
  room.submitThought(thinker, room.secretAnswer);
  room.submitClues(thinker, ['clue']);
  assert.throws(() => room.submitDrawing(artist, 'data:image/png,<img src=x onerror=alert(1)>'), /canvas drawing/);
  room.submitDrawing(artist, drawing);
  assert.throws(() => room.submitDrawing(artist, drawing), /already submitted/);
  room.stopTimer();
});

test('disconnecting a player does not leave drawing phase stuck', () => {
  const room = makeRoom(4);
  room.startGame();
  const thinker = room.thinkerId;
  const artists = [...room.players.keys()].filter((id) => id !== thinker);
  room.submitThought(thinker, room.secretAnswer);
  room.submitClues(thinker, ['clue']);
  room.removePlayer(artists[0]);
  for (const id of artists.slice(1)) room.submitDrawing(id, drawing);
  assert.equal(room.phase, 'choice');
  room.stopTimer();
});

test('hints are generated privately and spectators cannot draw', () => {
  const room = makeRoom(2);
  room.setGameSettings('p1', { clueCount: 2, hintCount: 1, hintType: 'first-letter', allowThinkerEditHints: false, allowSpectators: true, allowLateJoin: false });
  room.startGame();
  const thinker = room.thinkerId;
  room.submitThought(thinker, room.secretAnswer);
  assert.equal(room.getStateFor(thinker).hintSuggestions.length, 2);
  const spectator = room.addPlayer('spectator', 'Spectator', '🐸');
  assert.equal(spectator.spectator, true);
  room.submitClues(thinker, ['one', 'two']);
  assert.throws(() => room.submitDrawing('spectator', drawing), /Spectators cannot/);
  room.stopTimer();
});

test('collects round memories and reveals creators only after the game ends', () => {
  const room = makeRoom(4);
  room.setGameSettings('p1', { rounds: 1, clueCount: 1 });
  room.startGame();
  const thinker = room.thinkerId;
  const artists = [...room.players.keys()].filter((id) => id !== thinker);
  room.submitThought(thinker, room.secretAnswer);
  room.submitClues(thinker, ['A strange clue']);
  artists.forEach((id) => room.submitDrawing(id, drawing));
  assert.equal(room.memoryGallery.length, 3);
  assert.equal(room.getStateFor(thinker).memories.length, 0);
  room.chooseDrawing(thinker, 1, true);
  room.endGame('p1');
  room.finalStage = 'reveal';
  const memories = room.getStateFor('p2').memories;
  assert.equal(memories.length, 3);
  assert.ok(memories.every((memory) => memory.round === 1 && memory.artistName && memory.thought));
  assert.equal(memories.filter((memory) => memory.selected).length, 1);
  assert.equal(memories.filter((memory) => memory.funny).length, 1);
  room.stopTimer();
});
