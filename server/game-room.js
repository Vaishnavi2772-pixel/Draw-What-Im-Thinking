const MAX_PLAYERS = 12;
const PHASE_TIME_MS = 90_000;

const AVATARS = ['😀', '😎', '🤓', '🥳', '😈', '👻', '🤖', '🐱', '🐶', '🦊', '🐼', '🐸', '🐯', '🐰', '🐵', '🐨', '🦄', '👽', '👹', '🧙', '🥷', '🧑‍🚀', '🧛'];
const BUILTIN_WORDS = {
  random: ['A penguin running a tiny bakery', 'A wizard late for the bus', 'A cat stealing pizza from an astronaut', 'A dinosaur trying yoga', 'A teacher fighting a very polite dragon', 'A robot learning to dance at a wedding', 'A grandma winning a race against a cheetah'],
  movies: ['A superhero stuck in a lift', 'A detective interviewing a talking sandwich', 'A pirate directing a musical'],
  games: ['A gamer fighting a giant pillow', 'A character getting lost in a tutorial', 'A champion celebrating with a banana'],
  animals: ['A rabbit running a restaurant', 'A dog doing a magic trick', 'A giraffe trying to hide behind a lamp'],
  weird: ['A cloud applying for a job', 'A ghost afraid of a bedsheet', 'A spoon becoming the mayor'],
  college: ['A student sleeping through an exam', 'A professor riding a skateboard', 'A roommate guarding the last snack'],
  food: ['A taco going on a date', 'A noodle escaping a soup bowl', 'A samosa becoming a detective'],
  situations: ['Someone is late to their own surprise party', 'A family arguing with a weather forecast', 'A suitcase refusing to travel'],
};
const WORD_MODES = ['random', 'host', 'everyone'];
const WORD_CATEGORIES = ['random', 'movies', 'games', 'animals', 'weird', 'college', 'food', 'situations', 'mixed', 'custom'];

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function shuffle(items) {
  return [...items].sort(() => Math.random() - 0.5);
}

class GameRoom {
  constructor(code, hostSocketId) {
    this.code = code;
    this.hostId = hostSocketId;
    this.players = new Map();
    this.settings = {
      hintsEnabled: true, hintCount: 3, hintType: 'text', hintTimeLimit: 90, allowThinkerEditHints: true,
      minPlayers: 2, maxPlayers: 12, allowLateJoin: false, allowSpectators: false, autoRemoveInactive: false, allowDuplicateAvatars: true,
      clueCount: 3, secretWordLimit: 100, customWordLimit: 2000, drawingTime: 75, rounds: 3, everyoneTurns: false,
      winnerPoints: 100, thinkerPoints: 50, funniestEnabled: true, funniestPoints: 25, voiceEnabled: true,
    };
    this.phase = 'lobby';
    this.round = 0;
    this.thinkerId = null;
    this.thinkerOrder = [];
    this.secretAnswer = '';
    this.wordMode = 'random';
    this.wordCategory = 'random';
    this.minimumWords = 3;
    this.customWords = [];
    this.contributedWords = [];
    this.usedWords = [];
    this.wordId = 0;
    this.clues = [];
    this.drawings = new Map();
    this.revealDrawings = [];
    this.memoryGallery = [];
    this.winnerId = null;
    this.funniestId = null;
    this.finalStage = null;
    this.deadline = null;
    this.timer = null;
    this.onChange = null;
  }

  addPlayer(socketId, name, avatar) {
    const joiningAfterStart = this.phase !== 'lobby';
    if (joiningAfterStart && !this.settings.allowLateJoin && !this.settings.allowSpectators) throw new Error('This room has already started.');
    if (this.players.size >= this.settings.maxPlayers) throw new Error(`This room is full (${this.settings.maxPlayers} players maximum).`);
    const cleanName = String(name || '').trim().slice(0, 18);
    if (cleanName.length < 1) throw new Error('Please enter a name.');
    if ([...this.players.values()].some((player) => player.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new Error('That name is already being used in this room.');
    }
    if (!this.settings.allowDuplicateAvatars && AVATARS.includes(avatar) && [...this.players.values()].some((player) => player.avatar === avatar)) throw new Error('That avatar is already being used. Choose another.');
    const player = {
      id: socketId,
      name: cleanName,
      avatar: this.settings.allowDuplicateAvatars && AVATARS.includes(avatar) ? avatar : AVATARS[this.players.size % AVATARS.length],
      score: 0,
      submitted: false,
      connected: true,
      voiceMuted: true,
      spectator: joiningAfterStart && !this.settings.allowLateJoin && this.settings.allowSpectators,
      lastActiveAt: Date.now(),
    };
    this.players.set(socketId, player);
    this.refreshInactivityTimer();
    return player;
  }

  removePlayer(socketId) {
    const wasThinker = socketId === this.thinkerId;
    this.players.delete(socketId);
    if (this.hostId === socketId) this.hostId = this.players.keys().next().value || null;
    this.drawings.delete(socketId);
    if (wasThinker && this.phase !== 'lobby' && this.phase !== 'results' && this.phase !== 'final') {
      this.phase = 'lobby';
      this.round = 0;
      this.thinkerId = null;
      this.stopTimer();
    }
    if (this.phase === 'drawing') this.maybeReveal();
    this.refreshInactivityTimer();
  }

  touchPlayer(socketId) {
    const player = this.players.get(socketId);
    if (player) player.lastActiveAt = Date.now();
  }

  refreshInactivityTimer() {
    if (this.inactivityTimer) clearInterval(this.inactivityTimer);
    this.inactivityTimer = null;
    if (!this.settings.autoRemoveInactive || this.players.size === 0) return;
    this.inactivityTimer = setInterval(() => {
      const cutoff = Date.now() - 120_000;
      for (const [id, player] of this.players) if (id !== this.hostId && player.lastActiveAt < cutoff) this.removePlayer(id);
      this.onChange?.();
    }, 30_000);
  }

  removePlayerByHost(socketId, playerId) {
    if (this.phase !== 'lobby') throw new Error('Players can only be removed from the lobby.');
    if (socketId !== this.hostId) throw new Error('Only the host can remove players.');
    if (!this.players.has(playerId)) throw new Error('That player is no longer in the room.');
    if (playerId === this.hostId) throw new Error('The host cannot remove themselves.');
    this.removePlayer(playerId);
  }

  setVoiceState(socketId, muted) {
    const player = this.players.get(socketId);
    if (!player) throw new Error('You are not in this room.');
    if (!this.settings.voiceEnabled && !muted) throw new Error('Voice chat is disabled for this game.');
    player.voiceMuted = Boolean(muted);
  }

  startGame() {
    if ([...this.players.values()].filter((player) => !player.spectator).length < this.settings.minPlayers) throw new Error(`You need at least ${this.settings.minPlayers} players to start.`);
    this.assertWordSettings();
    this.round = 1;
    this.thinkerOrder = shuffle([...this.players.keys()]);
    this.beginThoughtRound();
  }

  beginThoughtRound() {
    const activeIds = [...this.players.values()].filter((player) => !player.spectator).map((player) => player.id);
    this.thinkerOrder = this.thinkerOrder.filter((id) => this.players.has(id));
    for (const id of activeIds) if (!this.thinkerOrder.includes(id)) this.thinkerOrder.push(id);
    this.thinkerId = this.thinkerOrder[(this.round - 1) % this.thinkerOrder.length];
    this.secretAnswer = this.pickNextWord();
    this.clues = [];
    this.drawings.clear();
    this.revealDrawings = [];
    this.winnerId = null;
    this.funniestId = null;
    for (const player of this.players.values()) player.submitted = false;
    this.setPhase('thought', this.settings.hintTimeLimit * 1000);
  }

  submitThought(socketId, answer) {
    this.assertPhaseAndThinker(socketId, 'thought');
    if (String(answer || '').trim() !== this.secretAnswer) throw new Error('That secret word does not match the room selection.');
    if (!this.settings.hintsEnabled) {
      this.clues = [];
      this.setPhase('drawing', this.settings.drawingTime * 1000);
      return;
    }
    this.setPhase('clues', this.settings.hintTimeLimit * 1000);
  }

  setWordSettings(socketId, settings) {
    if (this.phase !== 'lobby') throw new Error('Word settings can only change in the lobby.');
    if (socketId !== this.hostId) throw new Error('Only the host can change word settings.');
    const mode = String(settings.mode || 'random');
    const category = String(settings.category || 'random');
    const minimumWords = Number(settings.minimumWords || 3);
    if (!WORD_MODES.includes(mode)) throw new Error('That word mode is not available.');
    if (!WORD_CATEGORIES.includes(category)) throw new Error('That category is not available.');
    if (!Number.isInteger(minimumWords) || minimumWords < 1 || minimumWords > 100) throw new Error('Minimum words must be between 1 and 100.');
    this.wordMode = mode;
    this.wordCategory = category;
    this.minimumWords = minimumWords;
  }

  setGameSettings(socketId, settings) {
    if (this.phase !== 'lobby') throw new Error('Game settings lock after the game starts.');
    if (socketId !== this.hostId) throw new Error('Only the host can change game settings.');
    const next = { ...this.settings, ...settings };
    const integers = ['hintCount', 'hintTimeLimit', 'minPlayers', 'maxPlayers', 'clueCount', 'secretWordLimit', 'customWordLimit', 'drawingTime', 'rounds', 'winnerPoints', 'thinkerPoints', 'funniestPoints'];
    for (const field of integers) if (!Number.isInteger(Number(next[field]))) throw new Error(`${field} must be a whole number.`);
    if (next.hintCount < 1 || next.hintCount > 3 || next.clueCount < 1 || next.clueCount > 5) throw new Error('Hints and clues must be between 1 and 5.');
    if (next.minPlayers < 2 || next.minPlayers > 12 || next.maxPlayers < next.minPlayers || next.maxPlayers > 12) throw new Error('Player limits must be between 2 and 12.');
    if (next.secretWordLimit < 10 || next.secretWordLimit > 2000 || next.customWordLimit < 1 || next.customWordLimit > 2000) throw new Error('Text limits are outside the allowed range.');
    if (this.customWords.length > next.customWordLimit || this.contributedWords.length > next.customWordLimit) throw new Error('Custom word limit cannot be lower than the current pool.');
    if (next.drawingTime < 30 || next.drawingTime > 180 || next.rounds < 1 || next.rounds > 50) throw new Error('Drawing time or rounds are outside the allowed range.');
    if (this.players.size > next.maxPlayers) throw new Error('Maximum players cannot be lower than the current player count.');
    this.settings = {
      ...next,
      hintsEnabled: Boolean(next.hintsEnabled), allowThinkerEditHints: Boolean(next.allowThinkerEditHints), allowLateJoin: Boolean(next.allowLateJoin),
      allowSpectators: Boolean(next.allowSpectators), autoRemoveInactive: Boolean(next.autoRemoveInactive), allowDuplicateAvatars: Boolean(next.allowDuplicateAvatars),
      everyoneTurns: Boolean(next.everyoneTurns), funniestEnabled: Boolean(next.funniestEnabled), voiceEnabled: Boolean(next.voiceEnabled),
    };
    this.refreshInactivityTimer();
  }

  getHintSuggestions(socketId) {
    if (socketId !== this.thinkerId || !this.settings.hintsEnabled) return [];
    const word = this.secretAnswer;
    const suggestions = this.settings.hintType === 'first-letter'
      ? [`It starts with the letter ${word.trim().charAt(0).toUpperCase()}.`]
      : this.settings.hintType === 'category'
        ? [`It belongs in the ${this.wordCategory} corner of the universe.`]
        : this.settings.hintType === 'text'
          ? [`It is made of ${word.trim().split(/\s+/).length} words.`]
          : ['Something surprising is happening.', 'This would make a very strange picture.', 'Nobody expected this today.'];
    return Array.from({ length: this.settings.clueCount }, (_, index) => suggestions[index % Math.min(this.settings.hintCount, suggestions.length)]);
  }

  addWord(socketId, word) {
    if (this.phase !== 'lobby') throw new Error('Words can only be added in the lobby.');
    if (this.wordMode === 'host' && socketId !== this.hostId) throw new Error('Only the host can add words in this mode.');
    if (this.wordMode !== 'host' && this.wordMode !== 'everyone') throw new Error('Choose a custom word mode first.');
    const cleanWord = String(word || '').trim().slice(0, 120);
    if (!cleanWord) throw new Error('Write a word or phrase first.');
    const existing = this.wordMode === 'host' ? this.customWords : this.contributedWords;
    if (existing.length >= this.settings.customWordLimit) throw new Error(`The custom word limit of ${this.settings.customWordLimit} has been reached.`);
    if (existing.some((item) => (item.text || item).toLowerCase() === cleanWord.toLowerCase())) throw new Error('That word is already in the secret pool.');
    if (this.wordMode === 'host') this.customWords.push({ id: `word-${++this.wordId}`, text: cleanWord });
    else this.contributedWords.push(cleanWord);
  }

  editWord(socketId, wordId, word) {
    if (this.phase !== 'lobby' || this.wordMode !== 'host') throw new Error('Host words can only be edited in the lobby.');
    if (socketId !== this.hostId) throw new Error('Only the host can edit words.');
    const target = this.customWords.find((item) => item.id === wordId);
    const cleanWord = String(word || '').trim().slice(0, 120);
    if (!target || !cleanWord) throw new Error('That word could not be edited.');
    target.text = cleanWord;
  }

  deleteWord(socketId, wordId) {
    if (this.phase !== 'lobby' || this.wordMode !== 'host' || socketId !== this.hostId) throw new Error('Only the host can delete host words in the lobby.');
    this.customWords = this.customWords.filter((item) => item.id !== wordId);
  }

  clearWords(socketId) {
    if (this.phase !== 'lobby' || this.wordMode !== 'host' || socketId !== this.hostId) throw new Error('Only the host can clear host words in the lobby.');
    this.customWords = [];
  }

  assertWordSettings() {
    if (this.wordMode === 'host' && this.customWords.length < this.minimumWords) throw new Error(`Add at least ${this.minimumWords} host words before starting.`);
    if (this.wordMode === 'everyone' && this.contributedWords.length < this.minimumWords) throw new Error(`Wait for at least ${this.minimumWords} secret words before starting.`);
  }

  wordPool() {
    if (this.wordMode === 'host') return this.customWords.map((item) => item.text);
    if (this.wordMode === 'everyone') return [...this.contributedWords];
    if (this.wordCategory === 'mixed') return Object.values(BUILTIN_WORDS).flat();
    if (this.wordCategory === 'custom') return BUILTIN_WORDS.random;
    return BUILTIN_WORDS[this.wordCategory] || BUILTIN_WORDS.random;
  }

  pickNextWord() {
    const pool = this.wordPool().filter((word) => String(word).trim().split(/\s+/).length <= this.settings.secretWordLimit);
    if (!pool.length) throw new Error('There are no words available for this round.');
    let available = pool.filter((word) => !this.usedWords.includes(word));
    if (!available.length) {
      this.usedWords = [];
      available = pool;
    }
    const word = available[Math.floor(Math.random() * available.length)];
    this.usedWords.push(word);
    return word;
  }

  submitClues(socketId, clues) {
    this.assertPhaseAndThinker(socketId, 'clues');
    if (!this.settings.hintsEnabled) throw new Error('Hints are disabled for this game.');
    if (!Array.isArray(clues) || clues.length !== this.settings.clueCount) throw new Error(`Please provide exactly ${this.settings.clueCount} clues.`);
    const cleanClues = clues.map((clue) => String(clue || '').trim().slice(0, 120));
    if (cleanClues.some((clue) => !clue)) throw new Error('All 3 clues need a little something.');
    this.clues = cleanClues;
    this.setPhase('drawing', this.settings.drawingTime * 1000);
  }

  submitDrawing(socketId, image) {
    if (this.phase !== 'drawing') throw new Error('Drawing submissions are closed.');
    if (socketId === this.thinkerId) throw new Error('The thinker waits while everyone draws.');
    if (!this.players.has(socketId)) throw new Error('You are not in this room.');
    if (this.players.get(socketId).spectator) throw new Error('Spectators cannot submit drawings.');
    if (this.drawings.has(socketId)) throw new Error('You already submitted your drawing.');
    if (typeof image !== 'string' || !/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/]+=*$/.test(image)) throw new Error('Please submit a canvas drawing.');
    if (image.length > 2_500_000) throw new Error('That drawing is too large. Try a simpler sketch.');
    this.drawings.set(socketId, image);
    this.players.get(socketId).submitted = true;
    this.maybeReveal();
  }

  maybeReveal() {
    const artistCount = [...this.players.values()].filter((player) => !player.spectator && player.id !== this.thinkerId).length;
    if (artistCount > 0 && this.drawings.size >= artistCount) {
      this.stopTimer();
      this.revealDrawings = shuffle([...this.drawings.entries()]).map(([artistId, image], index) => ({
        number: index + 1,
        artistId,
        image,
      }));
      this.memoryGallery.push(...this.revealDrawings.map((drawing) => ({
        id: `${this.round}-${drawing.artistId}`,
        round: this.round,
        artistId: drawing.artistId,
        image: drawing.image,
        thought: this.secretAnswer,
        clues: [...this.clues],
        selected: false,
        funny: false,
      })));
      this.setPhase('choice', PHASE_TIME_MS);
    }
  }

  chooseDrawing(socketId, number, funny = false) {
    this.assertPhaseAndThinker(socketId, 'choice');
    const selected = this.revealDrawings.find((drawing) => drawing.number === Number(number));
    if (!selected) throw new Error('That drawing is not available.');
    this.winnerId = selected.artistId;
    if (funny && this.settings.funniestEnabled) this.funniestId = selected.artistId;
    for (const memory of this.memoryGallery) {
      if (memory.round === this.round) {
        memory.selected = memory.artistId === selected.artistId;
        memory.funny = Boolean(funny && this.settings.funniestEnabled && memory.selected);
      }
    }
    const winner = this.players.get(selected.artistId);
    if (winner) winner.score += this.settings.winnerPoints;
    const thinker = this.players.get(this.thinkerId);
    if (thinker) thinker.score += this.settings.thinkerPoints;
    if (funny && winner && this.settings.funniestEnabled) winner.score += this.settings.funniestPoints;
    this.setPhase('results', 12_000);
  }

  nextRound(socketId) {
    if (socketId !== this.hostId) throw new Error('Only the host can begin the next round.');
    if (this.phase !== 'results') throw new Error('The round is still in progress.');
    if (this.shouldEndAfterRound()) return this.endGame(socketId);
    this.round += 1;
    this.beginThoughtRound();
  }

  endGame(socketId) {
    if (socketId !== this.hostId) throw new Error('Only the host can end the game.');
    this.stopTimer();
    if (this.inactivityTimer) clearInterval(this.inactivityTimer);
    this.inactivityTimer = null;
    this.finalStage = 'leaderboard';
    this.setPhase('final', 4_500);
  }

  setPhase(phase, duration) {
    this.stopTimer();
    this.phase = phase;
    this.deadline = duration ? Date.now() + duration : null;
    if (duration) {
      this.timer = setTimeout(() => {
        this.handleTimeout();
        this.onChange?.();
      }, duration);
    }
  }

  handleTimeout() {
    this.timer = null;
    this.deadline = null;
    if (this.phase === 'drawing') {
      for (const [id, player] of this.players) {
        if (id !== this.thinkerId && !this.drawings.has(id)) {
          this.drawings.set(id, '');
          player.submitted = true;
        }
      }
      this.maybeReveal();
    } else if (this.phase === 'choice') {
      const first = this.revealDrawings[0];
      if (first && this.players.has(this.thinkerId)) this.chooseDrawing(this.thinkerId, first.number, false);
    } else if (this.phase === 'results') {
      if (this.shouldEndAfterRound()) return this.endGame(this.hostId);
      this.round += 1;
      this.beginThoughtRound();
    } else if (this.phase === 'thought' || this.phase === 'clues') {
      this.beginThoughtRound();
    } else if (this.phase === 'final' && this.finalStage === 'leaderboard') {
      this.finalStage = 'reveal';
      this.setPhase('final', null);
    }
  }

  shouldEndAfterRound() {
    const activePlayerCount = [...this.players.values()].filter((player) => !player.spectator).length;
    return this.settings.everyoneTurns ? this.round >= activePlayerCount : this.round >= this.settings.rounds;
  }

  stopTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  assertPhaseAndThinker(socketId, phase) {
    if (this.phase !== phase) throw new Error('That step has already moved on.');
    if (socketId !== this.thinkerId) throw new Error('Only the thinker can do that.');
  }

  getStateFor(socketId) {
    const playerList = [...this.players.values()].map(({ id, name, avatar, score, submitted, voiceMuted }) => ({
      id, name, avatar, score, voiceMuted, spectator: this.players.get(id)?.spectator || false, submitted: this.phase === 'drawing' ? submitted : false,
    }));
    const state = {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      thinkerId: this.thinkerId,
      thinkerName: this.players.get(this.thinkerId)?.name || '',
      players: playerList,
      clues: this.clues,
      drawings: this.phase === 'choice' || this.phase === 'results'
        ? this.revealDrawings.map(({ number, image }) => ({ number, image }))
        : [],
      winnerId: this.winnerId,
      winnerName: this.players.get(this.winnerId)?.name || '',
      winnerAvatar: this.players.get(this.winnerId)?.avatar || '',
      funniestId: this.funniestId,
      funniestName: this.players.get(this.funniestId)?.name || '',
      finalStage: this.finalStage,
      deadline: this.deadline,
      isThinker: socketId === this.thinkerId,
      isHost: socketId === this.hostId,
      submitted: this.players.get(socketId)?.submitted || false,
      secretAnswer: socketId === this.thinkerId ? this.secretAnswer : '',
      wordMode: this.wordMode,
      wordCategory: this.wordCategory,
      minimumWords: this.minimumWords,
      wordCount: this.wordMode === 'host' ? this.customWords.length : this.wordMode === 'everyone' ? this.contributedWords.length : this.wordPool().length,
      customWords: socketId === this.hostId && this.wordMode === 'host' ? this.customWords : [],
      hintSuggestions: this.getHintSuggestions(socketId),
      settings: this.settings,
      settingsPreview: {
        players: `${this.players.size} / ${this.settings.maxPlayers}`,
        rounds: this.settings.everyoneTurns ? 'Everyone gets a turn' : this.settings.rounds,
        clues: this.settings.hintsEnabled ? this.settings.clueCount : 0,
        drawingTime: `${this.settings.drawingTime} sec`,
        voice: this.settings.voiceEnabled,
      },
      selectedDrawing: this.phase === 'results' ? this.revealDrawings.find((drawing) => drawing.artistId === this.winnerId)?.number || null : null,
      memories: [],
    };
    if (this.phase === 'results' || this.phase === 'final') {
      state.drawings = this.revealDrawings.map(({ number, image }) => ({ number, image, artistId: this.phase === 'final' ? this.revealDrawings.find((item) => item.number === number)?.artistId : undefined }));
      state.secretAnswer = this.secretAnswer;
    }
    if (this.phase === 'final' && this.finalStage === 'reveal') {
      state.memories = this.memoryGallery.map((memory) => ({
        ...memory,
        artistName: this.players.get(memory.artistId)?.name || 'Former player',
        artistAvatar: this.players.get(memory.artistId)?.avatar || '🎨',
        result: memory.selected ? 'Thinker\'s Choice' : memory.funny ? 'Funniest Drawing' : '',
      }));
    }
    return state;
  }
}

module.exports = { GameRoom, randomCode, MAX_PLAYERS };
