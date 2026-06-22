// ===============================
// БАЗОВАЯ НАСТРОЙКА
// ===============================
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

// ===============================
// ХРАНИЛИЩА
// ===============================

// playerId → { playerId, name, socketId, isConnected, roomId }
const players = new Map();

// roomId → { players:[playerId1,playerId2], currentTurn, round, timers... }
const games = new Map();

// очередь ожидания: массив playerId
const waitingQueue = [];

// ===============================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ===============================
function uuid() {
  return crypto.randomBytes(8).toString('hex');
}

function generateRoomId() {
  return 'room_' + uuid();
}

function getRandomTheme() {
  const themes = ['Осень', 'Любовь', 'Роботы', 'Кофе', 'Сон', 'Город', 'Море', 'Космос', 'Дружба', 'Время'];
  return themes[Math.floor(Math.random() * themes.length)];
}

function getOpponent(room, playerId) {
  return room.players.find(id => id !== playerId);
}

// ===============================
// МАТЧМЕЙКИНГ
// ===============================
function tryMatch() {
  if (waitingQueue.length < 2) return;

  const p1 = waitingQueue.shift();
  const p2 = waitingQueue.shift();

  const roomId = generateRoomId();
  const theme = getRandomTheme();

  const first = Math.random() < 0.5 ? p1 : p2;
  const second = first === p1 ? p2 : p1;

  const room = {
    roomId,
    players: [p1, p2],
    currentTurn: first,
    round: 1,
    theme,
    timeLeft: 180,
    turnTimeLeft: 10,
    history: [],
    interval: null,
    isActive: true
  };

  games.set(roomId, room);

  players.get(p1).roomId = roomId;
  players.get(p2).roomId = roomId;

  // отправляем старт
  [p1, p2].forEach(pid => {
    const pl = players.get(pid);
    if (pl.socketId) {
      io.to(pl.socketId).emit('game_started', {
        roomId,
        playerId: pid,
        opponentName: players.get(getOpponent(room, pid)).name,
        theme,
        round: 1,
        currentTurn: room.currentTurn
      });
    }
  });

  startGameLoop(roomId);
}

// ===============================
// ИГРОВОЙ ЦИКЛ
// ===============================
function startGameLoop(roomId) {
  const room = games.get(roomId);
  if (!room) return;

  if (room.interval) clearInterval(room.interval);

  room.interval = setInterval(() => {
    if (!room.isActive) return;

    room.timeLeft--;
    room.turnTimeLeft--;

    io.to(roomId).emit('game_tick', {
      timeLeft: room.timeLeft,
      turnTimeLeft: room.turnTimeLeft,
      currentTurn: room.currentTurn
    });

    if (room.turnTimeLeft <= 0) handleTurnTimeout(roomId);
    if (room.timeLeft <= 0) handleRoundEnd(roomId);

  }, 1000);
}

// ===============================
// ПРОПУСК ХОДА
// ===============================
function handleTurnTimeout(roomId) {
  const room = games.get(roomId);
  if (!room || !room.isActive) return;

  const current = room.currentTurn;
  const opponent = getOpponent(room, current);

  room.history.push({
    text: `... (${players.get(current).name} пропустил ход) ...`,
    authorId: 'system'
  });

  room.currentTurn = opponent;
  room.turnTimeLeft = 10;

  io.to(roomId).emit('turn_skipped', {
    playerName: players.get(current).name,
    currentTurn: room.currentTurn,
    turnTimeLeft: room.turnTimeLeft
  });
}

// ===============================
// КОНЕЦ РАУНДА
// ===============================
function handleRoundEnd(roomId) {
  const room = games.get(roomId);
  if (!room || !room.isActive) return;

  if (room.round >= 3) return finishGame(roomId);

  room.round++;
  room.timeLeft = 180;
  room.turnTimeLeft = 10;
  room.theme = getRandomTheme();
  room.currentTurn = room.round % 2 === 1 ? room.players[0] : room.players[1];

  io.to(roomId).emit('round_start', {
    round: room.round,
    theme: room.theme,
    currentTurn: room.currentTurn,
    timeLeft: room.timeLeft,
    turnTimeLeft: room.turnTimeLeft
  });
}

// ===============================
// КОНЕЦ ИГРЫ
// ===============================
function finishGame(roomId) {
  const room = games.get(roomId);
  if (!room) return;

  room.isActive = false;
  if (room.interval) clearInterval(room.interval);

  const poem = room.history
    .filter(l => l.authorId !== 'system')
    .map(l => l.text)
    .join('\n');

  io.to(roomId).emit('game_finished', {
    poem: poem || 'Ни одной строки не было написано 😅',
    history: room.history,
    players: room.players.map(pid => players.get(pid).name)
  });

  games.delete(roomId);
}

// ===============================
// СОКЕТЫ
// ===============================
io.on('connection', socket => {
  console.log('🟢 Новый сокет:', socket.id);

  // Игрок ищет игру
  socket.on('find_game', ({ name }) => {
    const playerId = uuid();

    players.set(playerId, {
      playerId,
      name,
      socketId: socket.id,
      isConnected: true,
      roomId: null
    });

    waitingQueue.push(playerId);

    socket.emit('queued', { playerId });

    tryMatch();
  });

  // Игрок заходит на game.html
  socket.on('join_game', ({ playerId, roomId }) => {
    const pl = players.get(playerId);
    if (!pl) return;

    pl.socketId = socket.id;
    pl.isConnected = true;

    socket.join(roomId);

    const room = games.get(roomId);
    if (!room) return;

    const opponent = getOpponent(room, playerId);

    socket.emit('game_state', {
      playerId,
      opponentId: opponent,
      myName: pl.name,
      opponentName: players.get(opponent).name,
      state: {
        currentTurn: room.currentTurn,
        timeLeft: room.timeLeft,
        turnTimeLeft: room.turnTimeLeft,
        history: room.history,
        lastLine: room.lastLine,
        isActive: room.isActive
      }
    });
  });

  // Игрок отправляет строку
  socket.on('submit_line', ({ playerId, roomId, text }) => {
    const room = games.get(roomId);
    if (!room || !room.isActive) return;

    if (room.currentTurn !== playerId) return;

    room.history.push({
      text: text.trim(),
      authorId: playerId
    });

    room.lastLine = text.trim();
    room.turnTimeLeft = 10;

    const opponent = getOpponent(room, playerId);
    room.currentTurn = opponent;

    io.to(roomId).emit('new_line', {
      lastLine: room.lastLine,
      authorId: playerId,
      author: players.get(playerId).name,
      currentTurn: room.currentTurn,
      turnTimeLeft: room.turnTimeLeft
    });
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log('🔴 Отключился сокет:', socket.id);

    for (const pl of players.values()) {
      if (pl.socketId === socket.id) {
        pl.isConnected = false;

        const roomId = pl.roomId;
        if (!roomId) return;

        const room = games.get(roomId);
        if (!room) return;

        // ждём 5 секунд — если игрок не вернулся, завершаем игру
        setTimeout(() => {
          if (!pl.isConnected && room.isActive) {
            io.to(roomId).emit('opponent_left');
            finishGame(roomId);
          }
        }, 5000);
      }
    }
  });
});

// ===============================
// СТАРТ СЕРВЕРА
// ===============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на ${PORT}`);
});
