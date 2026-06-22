const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// =============================================
// ХРАНЕНИЕ ДАННЫХ В ПАМЯТИ СЕРВЕРА
// =============================================

const waitingQueue = [];
const activeGames = new Map();

// =============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =============================================

function generateRoomId() {
  return 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

function getRandomTheme() {
  const themes = ['Осень', 'Любовь', 'Роботы', 'Кофе', 'Сон', 'Город', 'Море', 'Космос', 'Дружба', 'Время'];
  return themes[Math.floor(Math.random() * themes.length)];
}

// =============================================
// ПОИСК СОПЕРНИКА (Матчмейкинг)
// =============================================

function tryMatchPlayers() {
  if (waitingQueue.length < 2) return false;

  const player1 = waitingQueue.shift();
  const player2 = waitingQueue.shift();

  const roomId = generateRoomId();
  const theme = getRandomTheme();

  const gameData = {
    players: [player1, player2],
    currentTurn: player1.id,
    round: 1,
    timeLeft: 180,
    turnTimeLeft: 10,
    history: [],
    lastLine: null,
    theme: theme,
    isActive: true,
    interval: null,
    roundCount: 1,
    playerNames: {
      [player1.id]: player1.name,
      [player2.id]: player2.name
    },
    createdAt: Date.now()
  };

  activeGames.set(roomId, gameData);
  console.log(`✅ Игра создана: ${roomId}, игроки: ${player1.name} и ${player2.name}`);
  console.log(`📋 Всего активных игр: ${activeGames.size}`);

  // Подключаем игроков к комнате Socket.io
  player1.socket.join(roomId);
  player2.socket.join(roomId);

  // Отправляем событие о начале игры
  io.to(roomId).emit('game_started', {
    roomId: roomId,
    opponent: player2.name,
    theme: theme,
    round: 1,
    currentTurn: player1.id,
    youAre: 'player1'
  });

  io.to(player2.socket.id).emit('game_started', {
    roomId: roomId,
    opponent: player1.name,
    theme: theme,
    round: 1,
    currentTurn: player1.id,
    youAre: 'player2'
  });

  // Запускаем игровой цикл
  startGameLoop(roomId);

  return true;
}

// =============================================
// ИГРОВОЙ ЦИКЛ
// =============================================

function startGameLoop(roomId) {
  const game = activeGames.get(roomId);
  if (!game) return;

  if (game.interval) {
    clearInterval(game.interval);
  }

  game.interval = setInterval(() => {
    if (!game.isActive) {
      clearInterval(game.interval);
      return;
    }

    game.timeLeft--;
    game.turnTimeLeft--;

    io.to(roomId).emit('game_tick', {
      timeLeft: game.timeLeft,
      turnTimeLeft: game.turnTimeLeft,
      currentTurn: game.currentTurn
    });

    if (game.turnTimeLeft <= 0) {
      handleTurnTimeout(roomId);
    }

    if (game.timeLeft <= 0) {
      handleRoundEnd(roomId);
    }

  }, 1000);
}

// =============================================
// ОБРАБОТКА ХОДОВ
// =============================================

function handleTurnTimeout(roomId) {
  const game = activeGames.get(roomId);
  if (!game || !game.isActive) return;

  const currentPlayer = game.players.find(p => p.id === game.currentTurn);
  const opponent = game.players.find(p => p.id !== game.currentTurn);

  if (currentPlayer) {
    game.history.push({
      text: `... (${currentPlayer.name} пропустил ход) ...`,
      author: 'system',
      authorId: 'system',
      isSkip: true,
      timestamp: Date.now()
    });
  }

  game.currentTurn = opponent.id;
  game.turnTimeLeft = 10;

  io.to(roomId).emit('turn_skipped', {
    message: `${currentPlayer ? currentPlayer.name : 'Игрок'} пропустил ход`,
    currentTurn: game.currentTurn,
    turnTimeLeft: game.turnTimeLeft,
    playerName: currentPlayer ? currentPlayer.name : 'Игрок'
  });

  sendGameState(roomId);
}

// =============================================
// ОТПРАВКА СОСТОЯНИЯ ИГРЫ
// =============================================

function sendGameState(roomId) {
  const game = activeGames.get(roomId);
  if (!game) return;

  game.players.forEach(player => {
    const opponent = game.players.find(p => p.id !== player.id);
    player.socket.emit('game_state', {
      myId: player.id,
      opponentId: opponent ? opponent.id : null,
      myName: player.name,
      opponentName: opponent ? opponent.name : 'Соперник',
      state: {
        currentTurn: game.currentTurn,
        timeLeft: game.timeLeft,
        turnTimeLeft: game.turnTimeLeft,
        history: game.history,
        lastLine: game.lastLine,
        isActive: game.isActive
      }
    });
  });
}

// =============================================
// ОКОНЧАНИЕ РАУНДА
// =============================================

function handleRoundEnd(roomId) {
  const game = activeGames.get(roomId);
  if (!game || !game.isActive) return;

  if (game.round >= 3) {
    finishGame(roomId);
    return;
  }

  game.round++;
  game.timeLeft = 180;
  game.turnTimeLeft = 10;
  game.lastLine = null;

  const firstPlayer = game.round % 2 === 0 ? game.players[0] : game.players[1];
  game.currentTurn = firstPlayer.id;

  const newTheme = getRandomTheme();
  game.theme = newTheme;

  io.to(roomId).emit('round_start', {
    round: game.round,
    theme: newTheme,
    currentTurn: game.currentTurn,
    timeLeft: game.timeLeft,
    turnTimeLeft: game.turnTimeLeft
  });

  sendGameState(roomId);
  startGameLoop(roomId);
}

// =============================================
// ЗАВЕРШЕНИЕ ИГРЫ
// =============================================

function finishGame(roomId) {
  const game = activeGames.get(roomId);
  if (!game) return;

  game.isActive = false;

  if (game.interval) {
    clearInterval(game.interval);
    game.interval = null;
  }

  const fullPoem = game.history
    .filter(line => line.author !== 'system')
    .map(line => line.text)
    .join('\n');

  io.to(roomId).emit('game_finished', {
    poem: fullPoem || 'Ни одной строки не было написано 😅',
    history: game.history,
    players: game.players.map(p => p.name),
    rounds: game.round
  });

  // ⚠️ НЕ УДАЛЯЕМ ИГРУ, ЧТОБЫ ИГРОКИ МОГЛИ ПРОСМАТРИВАТЬ РЕЗУЛЬТАТ
  console.log(`🏁 Игра ${roomId} завершена, но сохранена в памяти`);
}

// =============================================
// ОБРАБОТЧИКИ СОКЕТОВ
// =============================================

io.on('connection', (socket) => {
  console.log('🟢 Подключился игрок:', socket.id);

  // ---- ПОИСК ИГРЫ ----
  socket.on('find_game', (data) => {
    const playerName = data?.name?.trim() || 'Аноним';
    console.log(`🔍 Игрок ${playerName} (${socket.id}) ищет игру`);

    const alreadyWaiting = waitingQueue.some(p => p.id === socket.id);
    if (alreadyWaiting) {
      socket.emit('error', 'Вы уже в очереди');
      return;
    }

    waitingQueue.push({
      id: socket.id,
      name: playerName,
      socket: socket,
      joinedAt: Date.now()
    });

    socket.emit('queued', { message: 'Вы в очереди. Ищем соперника...' });
    tryMatchPlayers();
  });

  // ---- ВХОД В КОМНАТУ ----
  socket.on('join_game', (data) => {
    const { roomId, name } = data;
    console.log(`👤 Игрок ${name} (${socket.id}) подключается к комнате ${roomId}`);

    // Проверяем, существует ли игра
    const game = activeGames.get(roomId);
    if (!game) {
      console.log(`❌ Игра ${roomId} не найдена в активных играх`);
      console.log(`📋 Активные игры: ${Array.from(activeGames.keys()).join(', ')}`);
      socket.emit('error', 'Игра не найдена');
      return;
    }

    // Проверяем, является ли игрок участником
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      console.log(`❌ Игрок ${socket.id} не участник игры ${roomId}`);
      socket.emit('error', 'Вы не участник этой игры');
      return;
    }

    socket.join(roomId);
    console.log(`✅ Игрок ${name} подключился к игре ${roomId}`);

    // Отправляем полное состояние игры
    const opponent = game.players.find(p => p.id !== socket.id);
    socket.emit('game_state', {
      myId: socket.id,
      opponentId: opponent ? opponent.id : null,
      myName: name,
      opponentName: opponent ? opponent.name : 'Соперник',
      state: {
        currentTurn: game.currentTurn,
        timeLeft: game.timeLeft,
        turnTimeLeft: game.turnTimeLeft,
        history: game.history,
        lastLine: game.lastLine,
        isActive: game.isActive
      }
    });

    // Отправляем тему и раунд
    socket.emit('round_start', {
      round: game.round,
      theme: game.theme,
      currentTurn: game.currentTurn,
      timeLeft: game.timeLeft,
      turnTimeLeft: game.turnTimeLeft
    });

    console.log(`📤 Отправлено состояние игры для ${name}`);
  });

  // ---- ОТПРАВКА СТРОКИ ----
  socket.on('submit_line', (data) => {
    const { roomId, text } = data;
    const game = activeGames.get(roomId);

    if (!game || !game.isActive) {
      socket.emit('error', 'Игра не найдена или уже завершена');
      return;
    }

    if (socket.id !== game.currentTurn) {
      socket.emit('error', 'Сейчас не твой ход');
      return;
    }

    if (!text || text.trim().length === 0) {
      socket.emit('error', 'Строка не может быть пустой');
      return;
    }

    const player = game.players.find(p => p.id === socket.id);
    const lineData = {
      text: text.trim(),
      author: player ? player.name : 'Игрок',
      authorId: socket.id,
      timestamp: Date.now()
    };

    game.history.push(lineData);
    game.lastLine = text.trim();

    const opponent = game.players.find(p => p.id !== socket.id);
    game.currentTurn = opponent.id;
    game.turnTimeLeft = 10;

    io.to(roomId).emit('new_line', {
      lastLine: game.lastLine,
      currentTurn: game.currentTurn,
      turnTimeLeft: game.turnTimeLeft,
      author: lineData.author,
      authorId: lineData.authorId
    });

    io.to(roomId).emit('turn_changed', {
      currentTurn: game.currentTurn,
      turnTimeLeft: game.turnTimeLeft
    });
  });

  // ---- ОТКЛЮЧЕНИЕ ----
  socket.on('disconnect', () => {
    console.log('🔴 Отключился игрок:', socket.id);

    const queueIndex = waitingQueue.findIndex(p => p.id === socket.id);
    if (queueIndex !== -1) {
      waitingQueue.splice(queueIndex, 1);
    }

    // Проверяем все активные игры
    for (const [roomId, game] of activeGames) {
      const playerInGame = game.players.some(p => p.id === socket.id);
      if (playerInGame) {
        console.log(`🚪 Игрок ${socket.id} вышел из игры ${roomId}`);
        io.to(roomId).emit('opponent_left', {
          message: 'Соперник покинул игру'
        });
        game.isActive = false;
        if (game.interval) {
          clearInterval(game.interval);
        }
        // ❌ НЕ УДАЛЯЕМ ИГРУ, ЧТОБЫ ДРУГОЙ ИГРОК МОГ ВИДЕТЬ СОСТОЯНИЕ
        break;
      }
    }
  });
});

// =============================================
// ЗАПУСК СЕРВЕРА
// =============================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`👥 Ожидаем игроков...`);
});