const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', credentials: true },
  transports: ['websocket', 'polling']
});

// ====== утилиты ======
const uuid = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

// ====== данные ======
const users = new Map();     // userId → { userId, login, pin, stats }
const sessions = new Map();  // playerId → { playerId, userId, socketId, roomId, isConnected, lastSeen }
const rooms = new Map();     // roomId → { roomId, ownerId, players, settings, state, isActive, inviteCode, lastActivity }
const quickQueue = [];       // очередь для быстрой игры

let totalGames = 0;
let totalLines = 0;

// ====== создание комнаты ======
function createRoom(ownerPlayerId, settings = {}) {
  const session = sessions.get(ownerPlayerId);
  if (!session) return null;

  const roomId = 'room_' + uuid();
  const inviteCode = uuid().slice(0, 6);

  const room = {
    roomId,
    ownerId: session.userId,
    players: [ownerPlayerId],
    settings: {
      rounds: settings.rounds || 3,
      roundTime: settings.roundTime || 180,
      turnTime: settings.turnTime || 30,
      access: settings.access || 'public',
      password: settings.password || null
    },
    state: null,
    isActive: false,
    inviteCode,
    lastActivity: now()
  };

  rooms.set(roomId, room);
  session.roomId = roomId;

  return room;
}

// ====== запуск игры ======
function startRoomGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.players.length !== 2) return;

  const [p1, p2] = room.players;
  const first = Math.random() < 0.5 ? p1 : p2;

  room.state = {
    currentTurn: first,
    round: 1,
    theme: 'Случайная тема',
    timeLeft: room.settings.roundTime,
    turnTimeLeft: room.settings.turnTime,
    history: [],
    interval: null
  };

  room.isActive = true;
  room.lastActivity = now();
  totalGames++;

  room.players.forEach(pid => {
    const s = sessions.get(pid);
    if (s?.socketId) {
      const oppId = room.players.find(x => x !== pid);
      const oppUser = users.get(sessions.get(oppId).userId);

      io.to(s.socketId).emit('game_started', {
        roomId,
        playerId: pid,
        opponentName: oppUser?.login || 'Гость',
        settings: room.settings,
        round: room.state.round,
        currentTurn: room.state.currentTurn
      });
    }
  });

  startGameLoop(roomId);
}

// ====== игровой цикл ======
function startGameLoop(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.state) return;

  if (room.state.interval) clearInterval(room.state.interval);

  room.state.interval = setInterval(() => {
    if (!room.isActive) return;

    room.state.timeLeft--;
    room.state.turnTimeLeft--;
    room.lastActivity = now();

    io.to(roomId).emit('game_tick', {
      timeLeft: room.state.timeLeft,
      turnTimeLeft: room.state.turnTimeLeft,
      currentTurn: room.state.currentTurn
    });

    if (room.state.turnTimeLeft <= 0) handleTurnTimeout(roomId);
    if (room.state.timeLeft <= 0) handleRoundEnd(roomId);
  }, 1000);
}

function getOpponent(room, playerId) {
  return room.players.find(id => id !== playerId);
}

// ====== пропуск хода ======
function handleTurnTimeout(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.state || !room.isActive) return;

  const current = room.state.currentTurn;
  const opponent = getOpponent(room, current);
  const user = users.get(sessions.get(current).userId);

  room.state.history.push({
    text: `... (${user?.login || 'Гость'} пропустил ход) ...`,
    authorId: 'system',
    timestamp: now()
  });

  room.state.currentTurn = opponent;
  room.state.turnTimeLeft = room.settings.turnTime;
  room.lastActivity = now();

  io.to(roomId).emit('turn_skipped', {
    playerName: user?.login || 'Гость',
    currentTurn: room.state.currentTurn,
    turnTimeLeft: room.state.turnTimeLeft
  });
}

// ====== конец раунда ======
function handleRoundEnd(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.state || !room.isActive) return;

  if (room.state.round >= room.settings.rounds) {
    return finishGame(roomId, 'normal');
  }

  room.state.round++;
  room.state.timeLeft = room.settings.roundTime;
  room.state.turnTimeLeft = room.settings.turnTime;
  room.state.currentTurn = room.state.round % 2 === 1 ? room.players[0] : room.players[1];
  room.lastActivity = now();

  io.to(roomId).emit('round_start', {
    round: room.state.round,
    currentTurn: room.state.currentTurn,
    timeLeft: room.state.timeLeft,
    turnTimeLeft: room.state.turnTimeLeft
  });
}

// ====== конец игры ======
function finishGame(roomId, reason = 'normal') {
  const room = rooms.get(roomId);
  if (!room || !room.state) return;

  room.isActive = false;
  if (room.state.interval) clearInterval(room.state.interval);

  const poem = room.state.history
    .filter(l => l.authorId !== 'system')
    .map(l => l.text)
    .join('\n');

  room.players.forEach(pid => {
    const s = sessions.get(pid);
    if (!s) return;
    const u = users.get(s.userId);
    if (!u) return;

    u.stats.games = (u.stats.games || 0) + 1;
    const myLines = room.state.history.filter(l => l.authorId === pid).length;
    u.stats.lines = (u.stats.lines || 0) + myLines;
  });

  totalLines += room.state.history.length;

  io.to(roomId).emit('game_finished', {
    poem: poem || 'Ни одной строки не было написано 😅',
    history: room.state.history,
    players: room.players.map(pid => {
      const s = sessions.get(pid);
      const u = users.get(s.userId);
      return u?.login || 'Гость';
    }),
    reason
  });

  rooms.delete(roomId);
}

// ====== автоочистка ======
setInterval(() => {
  const t = now();
  for (const [roomId, room] of rooms) {
    if (!room.isActive && t - room.lastActivity > 10 * 60 * 1000) {
      rooms.delete(roomId);
    }
    if (room.isActive && t - room.lastActivity > 10 * 60 * 1000) {
      finishGame(roomId, 'timeout_cleanup');
    }
  }
}, 60 * 1000);

// ====== онлайн-статистика ======
setInterval(() => {
  const all = [...sessions.values()].filter(s => s.isConnected);
  const online = all.length;
  const registered = all.filter(s => s.userId).length;
  const guests = online - registered;
  const inRooms = [...rooms.values()].filter(r => r.isActive).length;

  io.emit('online_stats', {
    online,
    registered,
    guests,
    inRooms,
    totalGames,
    totalLines
  });
}, 5000);

// ====== сокеты ======
io.on('connection', socket => {

  // ===== ЛОГИН =====
  socket.on('auth_login', ({ login, pin }) => {
    login = (login || '').trim();
    pin = (pin || '').trim();
    if (!login || !pin) {
      socket.emit('auth_error', 'Нужны логин и PIN');
      return;
    }

    let user = [...users.values()].find(u => u.login === login);
    if (!user) {
      const userId = uuid();
      user = { userId, login, pin, stats: { games: 0, lines: 0 } };
      users.set(userId, user);
    } else if (user.pin !== pin) {
      socket.emit('auth_error', 'Неверный PIN');
      return;
    }

    const playerId = uuid();
    sessions.set(playerId, {
      playerId,
      userId: user.userId,
      socketId: socket.id,
      roomId: null,
      isConnected: true,
      lastSeen: now()
    });

    socket.emit('auth_ok', {
      userId: user.userId,
      playerId,
      login: user.login,
      stats: user.stats
    });
  });

  // ===== ГОСТЬ =====
  socket.on('guest_play', () => {
    const playerId = uuid();

    sessions.set(playerId, {
      playerId,
      userId: null,
      socketId: socket.id,
      roomId: null,
      isConnected: true,
      lastSeen: now()
    });

    socket.emit('guest_ok', { playerId });
  });

  // ===== БЫСТРАЯ ИГРА =====
  socket.on('find_game', ({ name }) => {
    const session = [...sessions.values()].find(s => s.socketId === socket.id);
    if (!session) return;

    const displayName = session.userId
      ? users.get(session.userId).login
      : (name || 'Гость');

    quickQueue.push({ playerId: session.playerId, name: displayName });

    if (quickQueue.length >= 2) {
      const p1 = quickQueue.shift();
      const p2 = quickQueue.shift();

      const roomId = 'quick_' + uuid();

      const room = {
        roomId,
        ownerId: null,
        players: [p1.playerId, p2.playerId],
        settings: {
          rounds: 3,
          roundTime: 180,
          turnTime: 30,
          access: 'public'
        },
        state: null,
        isActive: false,
        inviteCode: null,
        lastActivity: now()
      };

      rooms.set(roomId, room);

      sessions.get(p1.playerId).roomId = roomId;
      sessions.get(p2.playerId).roomId = roomId;

      startRoomGame(roomId);

      [p1, p2].forEach(p => {
        const s = sessions.get(p.playerId);
        if (s?.socketId) {
          io.to(s.socketId).emit('game_started', {
            roomId,
            playerId: p.playerId,
            opponentName: p === p1 ? p2.name : p1.name,
            settings: room.settings,
            round: room.state.round,
            currentTurn: room.state.currentTurn
          });
        }
      });
    }
  });

  // ===== СПИСОК ПУБЛИЧНЫХ КОМНАТ =====
  socket.on('get_public_rooms', () => {
    const list = [...rooms.values()]
      .filter(r => r.settings.access === 'public' && !r.isActive)
      .map(r => ({
        roomId: r.roomId,
        owner: users.get(r.ownerId)?.login || 'Гость',
        players: r.players.length,
        settings: r.settings
      }));

    socket.emit('public_rooms', list);
  });

  // ===== СПИСОК ОНЛАЙН =====
  socket.on('get_online_list', () => {
    const list = [...sessions.values()]
      .filter(s => s.isConnected)
      .map(s => {
        const user = s.userId ? users.get(s.userId) : null;
        return {
          playerId: s.playerId,
          name: user ? user.login : 'Гость'
        };
      });

    socket.emit('online_list', list);
  });

  // ===== ПРИГЛАШЕНИЕ =====
  socket.on('invite_player', ({ from, to }) => {
    const fromSession = sessions.get(from);
    const toSession = sessions.get(to);
    if (!fromSession || !toSession) return;

    const fromUser = fromSession.userId ? users.get(fromSession.userId) : null;
    const fromName = fromUser ? fromUser.login : 'Гость';

    const roomId = 'invite_' + uuid();

    const room = {
      roomId,
      ownerId: fromSession.userId,
      players: [from, to],
      settings: {
        rounds: 3,
        roundTime: 180,
        turnTime: 30,
        access: 'private'
      },
      state: null,
      isActive: false,
      inviteCode: null,
      lastActivity: now()
    };

    rooms.set(roomId, room);
    fromSession.roomId = roomId;
    toSession.roomId = roomId;

    io.to(toSession.socketId).emit('invite', {
      from: fromName,
      roomId
    });
  });

  // ===== ПРИСОЕДИНЕНИЕ К КОМНАТЕ =====
  socket.on('join_room', ({ playerId, roomId, password }) => {
    const session = sessions.get(playerId);
    const room = rooms.get(roomId);
    if (!session || !room) {
      socket.emit('join_error', 'Комната не найдена');
      return;
    }

    if (room.settings.access === 'password' && room.settings.password !== password) {
      socket.emit('join_error', 'Неверный пароль');
      return;
    }

    if (room.players.length >= 2) {
      socket.emit('join_error', 'Комната уже заполнена');
      return;
    }

    room.players.push(playerId);
    session.roomId = roomId;
    room.lastActivity = now();

    socket.join(roomId);

    io.to(roomId).emit('room_updated', {
      roomId,
      players: room.players.map(pid => {
        const s = sessions.get(pid);
        const u = users.get(s.userId);
        return u?.login || 'Гость';
      })
    });
  });

  // ===== СТАРТ ИГРЫ В КОМНАТЕ =====
  socket.on('start_room_game', ({ playerId, roomId }) => {
    const session = sessions.get(playerId);
    const room = rooms.get(roomId);
    if (!session || !room) return;
    if (room.ownerId !== session.userId) return;
    if (room.players.length !== 2) return;

    startRoomGame(roomId);
  });

  // ===== ОТПРАВКА СТРОКИ =====
  socket.on('submit_line', ({ playerId, roomId, text }) => {
    const session = sessions.get(playerId);
    const room = rooms.get(roomId);
    if (!session || !room || !room.state || !room.isActive) return;
    if (room.state.currentTurn !== playerId) return;

    const clean = (text || '').trim();
    if (!clean) {
      socket.emit('error', 'Строка не может быть пустой');
      return;
    }

    room.state.history.push({
      text: clean,
      authorId: playerId,
      timestamp: now()
    });

    room.state.lastLine = clean;
    room.state.turnTimeLeft = room.settings.turnTime;
    room.lastActivity = now();

    const opponentId = getOpponent(room, playerId);
    room.state.currentTurn = opponentId;

    const user = users.get(session.userId);

    io.to(roomId).emit('new_line', {
      lastLine: clean,
      authorId: playerId,
      author: user?.login || 'Гость',
      currentTurn: room.state.currentTurn,
      turnTimeLeft: room.state.turnTimeLeft
    });
  });

  // ===== ОТКЛЮЧЕНИЕ =====
  socket.on('disconnect', () => {
    for (const s of sessions.values()) {
      if (s.socketId === socket.id) {
        s.isConnected = false;
        s.lastSeen = now();

        const roomId = s.roomId;
        if (!roomId) return;

        const room = rooms.get(roomId);
        if (!room || !room.isActive) return;

        setTimeout(() => {
          if (!s.isConnected && room.isActive) {
            const u = users.get(s.userId);
            io.to(roomId).emit('opponent_left', {
              name: u?.login || 'Гость'
            });
            finishGame(roomId, 'player_disconnected');
          }
        }, 5000);

        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на ${PORT}`);
});
