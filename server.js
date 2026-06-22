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

// playerId → { playerId, name, socketId, isConnected, roomId, lastSeen, lastLineAt }
const players = new Map();

// roomId → { players:[playerId1,playerId2], currentTurn, round, theme, timeLeft, turnTimeLeft, history, interval, isActive, lastActivity }
const games = new Map();

// очередь ожидания: массив { playerId, joinedAt }
const waitingQueue = [];

// статистика
let totalGames = 0;
let totalLines = 0;

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

function now() {
  return Date.now();
}

// ===============================
// МАТЧМЕЙКИНГ (умная очередь)
// ===============================
function tryMatch() {
  if (waitingQueue.length < 2) return;

  // сортируем по времени ожидания (старшие — первыми)
  waitingQueue.sort((a, b) => a.joinedAt - b.joinedAt);

  const p1 = waitingQueue.shift().playerId;
  const p2 = waitingQueue.shift().playerId;

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
    turnTimeLeft: 25,
    history: [],
    interval: null,
    isActive: true,
    lastActivity: now()
  };

  games.set(roomId, room);

  players.get(p1).roomId = roomId;
  players.get(p2).roomId = roomId;

  totalGames++;
  console.log(`🎮 Новая игра ${roomId}. Игроки: ${players.get(p1).name} vs ${players.get(p2).name}`);

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
    room.lastActivity = now();

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
    authorId: 'system',
    timestamp: now()
  });

  room.currentTurn = opponent;
  room.turnTimeLeft = 25;
  room.lastActivity = now();

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
  room.turnTimeLeft = 25;
  room.theme = getRandomTheme();
  room.currentTurn = room.round % 2 === 1 ? room.players[0] : room.players[1];
  room.lastActivity = now();

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
function finishGame(roomId, reason = 'normal') {
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
    players: room.players.map(pid => players.get(pid).name),
    reason
  });

  console.log(`🏁 Игра ${roomId} завершена. Причина: ${reason}. Строк: ${room.history.length}`);

  games.delete(roomId);
}

// ===============================
// АВТО-ОЧИСТКА ЗАВИСШИХ ИГР
// ===============================
setInterval(() => {
  const nowTs = now();
  for (const [roomId, room] of games) {
    const age = nowTs - room.lastActivity;
    // если 10 минут нет активности — удаляем
    if (age > 10 * 60 * 1000) {
      console.log(`🧹 Автоочистка игры ${roomId} (нет активности 10 минут)`);
      finishGame(roomId, 'timeout_cleanup');
    }
  }
}, 60 * 1000);

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
      name: name?.trim() || 'Аноним',
      socketId: socket.id,
      isConnected: true,
      roomId: null,
      lastSeen: now(),
      lastLineAt: 0
    });

    waitingQueue.push({ playerId, joinedAt: now() });

    socket.emit('queued', { playerId });

    console.log(`🔍 Игрок ${name} (${playerId}) встал в очередь`);
    tryMatch();
  });

  // Игрок заходит на game.html
  socket.on('join_game', ({ playerId, roomId }) => {
    const pl = players.get(playerId);
    if (!pl) {
      socket.emit('error', 'Игрок не найден');
      return;
    }

    pl.socketId = socket.id;
    pl.isConnected = true;
    pl.lastSeen = now();

    const room = games.get(roomId);
    if (!room) {
      socket.emit('error', 'Игра не найдена');
      return;
    }

    socket.join(roomId);

    const opponentId = getOpponent(room, playerId);
    const opponent = players.get(opponentId);

    socket.emit('game_state', {
      playerId,
      opponentId,
      myName: pl.name,
      opponentName: opponent.name,
      state: {
        currentTurn: room.currentTurn,
        timeLeft: room.timeLeft,
        turnTimeLeft: room.turnTimeLeft,
        history: room.history,
        lastLine: room.lastLine,
        isActive: room.isActive
      }
    });

    console.log(`👤 ${pl.name} (${playerId}) присоединился к игре ${roomId}`);
  });

  // Игрок отправляет строку
  socket.on('submit_line', ({ playerId, roomId, text }) => {
    const pl = players.get(playerId);
    const room = games.get(roomId);

    if (!pl || !room || !room.isActive) return;
    if (room.currentTurn !== playerId) return;

    const nowTs = now();

    // анти-спам: не чаще 1 строки в 800 мс
    if (nowTs - pl.lastLineAt < 800) {
      socket.emit('error', 'Слишком часто отправляешь строки');
      return;
    }

    if (!text || !text.trim()) {
      socket.emit('error', 'Строка не может быть пустой');
      return;
    }

    pl.lastLineAt = nowTs;
    room.lastActivity = nowTs;
    totalLines++;

    const cleanText = text.trim();

    room.history.push({
      text: cleanText,
      authorId: playerId,
      timestamp: nowTs
    });

    room.lastLine = cleanText;
    room.turnTimeLeft = 10;

    const opponentId = getOpponent(room, playerId);
    room.currentTurn = opponentId;

    io.to(roomId).emit('new_line', {
      lastLine: room.lastLine,
      authorId: playerId,
      author: pl.name,
      currentTurn: room.currentTurn,
      turnTimeLeft: room.turnTimeLeft
    });

    console.log(`✍️ ${pl.name}: "${cleanText}" (игра ${roomId})`);
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log('🔴 Отключился сокет:', socket.id);

    // ищем игрока по socketId
    for (const pl of players.values()) {
      if (pl.socketId === socket.id) {
        pl.isConnected = false;
        pl.lastSeen = now();

        const roomId = pl.roomId;
        if (!roomId) return;

        const room = games.get(roomId);
        if (!room || !room.isActive) return;

        console.log(`🚪 Игрок ${pl.name} временно отключился из игры ${roomId}`);

        // ждём 5 секунд — если не вернулся, завершаем игру
        setTimeout(() => {
          if (!pl.isConnected && room.isActive) {
            console.log(`⏱️ Игрок ${pl.name} не вернулся. Завершаем игру ${roomId}`);
            io.to(roomId).emit('opponent_left', { name: pl.name });
            finishGame(roomId, 'player_disconnected');
          }
        }, 5000);

        break;
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
  console.log('📊 Статистика будет выводиться в консоль по мере игр');
});
