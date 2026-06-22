const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// ✅ РАСШИРЕННЫЕ НАСТРОЙКИ CORS
app.use(cors({
  origin: "*", // Разрешаем запросы с любых сайтов
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

app.use(express.json());

// ✅ ДОПОЛНИТЕЛЬНЫЕ ЗАГОЛОВКИ ДЛЯ ВСЕХ ОТВЕТОВ
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const server = http.createServer(app);

// ✅ НАСТРОЙКИ SOCKET.IO С ПРАВИЛЬНЫМ CORS
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    transports: ['websocket', 'polling'] // Поддерживаем оба транспорта
  },
  allowEIO3: true
});

// =============================================
// ХРАНЕНИЕ ДАННЫХ
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
// ПОИСК СОПЕРНИКА
// =============================================

function tryMatchPlayers() {
  if (waitingQueue.length < 2) return false;

  const player1 = waitingQueue.shift();
  const player2 = waitingQueue.shift();

  const roomId = generateRoomId();
  const theme = getRandomTheme();

  const firstPlayer = Math.random() < 0.5 ? player1 : player2;
  const secondPlayer = firstPlayer === player1 ? player2 : player1;

  console.log(`🎲 Первый ход: ${firstPlayer.name}`);

  const gameData = {
    players: [player1, player2],
    currentTurn: firstPlayer.id,
    round: 1,
    timeLeft: 180,
    turnTimeLeft: 10,
    history: [],
    lastLine: null,
    theme: theme,
    isActive: true,
    interval: null,
    playerNames: {
      [player1.id]: player1.name,
      [player2.id]: player2.name
    },
    playerSockets: {
      [player1.id]: player1.socket,
      [player2.id]: player2.socket
    },
    createdAt: Date.now()
  };

  activeGames.set(roomId, gameData);
  console.log(`✅ Игра создана: ${roomId}`);
  console.log(`   👤 Игрок 1: ${player1.name} (${player1.id})`);
  console.log(`   👤 Игрок 2: ${player2.name} (${player2.id})`);
  console.log(`   🎯 Начинает: ${firstPlayer.name}`);

  player1.socket.join(roomId);
  player2.socket.join(roomId);

  io.to(roomId).emit('game_started', {
    roomId: roomId,
    opponent: player2.name,
    theme: theme,
    round: 1,
    currentTurn: firstPlayer.id,
    youAre: firstPlayer === player1 ? 'player1' : 'player2'
  });

  io.to(secondPlayer.socket.id).emit('game_started', {
    roomId: roomId,
    opponent: firstPlayer.name,
    theme: theme,
    round: 1,
    currentTurn: firstPlayer.id,
    youAre: firstPlayer === player1 ? 'player2' : 'player1'
  });

  startGameLoop(roomId);

  setTimeout(() => {
    sendGameState(roomId);
    io.to(roomId).emit('turn_changed', {
      currentTurn: firstPlayer.id,
      turnTimeLeft: 10
    });
  }, 1000);

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
  io.to(roomId).emit('turn_changed', {
    currentTurn: game.currentTurn,
    turnTimeLeft: game.turnTimeLeft
  });
}

// =============================================
// ОТПРАВКА СОСТОЯНИЯ ИГРЫ
// =============================================

function sendGameState(roomId) {
  const game = activeGames.get(roomId);
  if (!game) return;

  game.players.forEach(player => {
    const opponent = game.players.find(p => p.id !== player.id);
    io.to(player.id).emit('game_state', {
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
  io.to(roomId).emit('turn_changed', {
    currentTurn: game.currentTurn,
    turnTimeLeft: game.turnTimeLeft
  });
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

  console.log(`🏁 Игра ${roomId} завершена`);
}

// =============================================
// ОБРАБОТЧИКИ СОКЕТОВ
// =============================================

io.on('connection', (socket) => {
  console.log('🟢 Подключился игрок:', socket.id);

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

  socket.on('join_game', (data) => {
    const { roomId, name } = data;
    console.log(`👤 Попытка подключения: ${name} (${socket.id}) к комнате ${roomId}`);

    const game = activeGames.get(roomId);
    if (!game) {
      console.log(`❌ Игра ${roomId} не найдена`);
      socket.emit('error', 'Игра не найдена');
      return;
    }

    const player = game.players.find(p => p.name === name);
    
    if (!player) {
      console.log(`❌ Игрок с именем "${name}" не найден`);
      socket.emit('error', 'Вы не участник этой игры');
      return;
    }

    const oldId = player.id;
    player.id = socket.id;
    player.socket = socket;
    
    game.playerSockets[oldId] = socket;
    delete game.playerSockets[oldId];
    game.playerSockets[socket.id] = socket;

    console.log(`✅ Игрок ${name} обновил соединение (старый ID: ${oldId})`);

    socket.join(roomId);

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

    socket.emit('round_start', {
      round: game.round,
      theme: game.theme,
      currentTurn: game.currentTurn,
      timeLeft: game.timeLeft,
      turnTimeLeft: game.turnTimeLeft
    });

    socket.emit('turn_changed', {
      currentTurn: game.currentTurn,
      turnTimeLeft: game.turnTimeLeft
    });

    console.log(`📤 Отправлено состояние для ${name}`);
    console.log(`   🎯 Текущий ход: ${game.currentTurn === socket.id ? 'ТВОЙ' : 'СОПЕРНИКА'}`);
  });

  socket.on('submit_line', (data) => {
    const { roomId, text } = data;
    const game = activeGames.get(roomId);

    if (!game || !game.isActive) {
      socket.emit('error', 'Игра не найдена или завершена');
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

    console.log(`📝 ${player.name}: "${text}"`);
  });

  socket.on('disconnect', () => {
    console.log('🔴 Отключился игрок:', socket.id);

    const queueIndex = waitingQueue.findIndex(p => p.id === socket.id);
    if (queueIndex !== -1) {
      waitingQueue.splice(queueIndex, 1);
    }

    for (const [roomId, game] of activeGames) {
      const playerInGame = game.players.some(p => p.id === socket.id);
      if (playerInGame) {
        console.log(`🚪 Игрок вышел из игры ${roomId}`);
        io.to(roomId).emit('opponent_left', {
          message: 'Соперник покинул игру'
        });
        game.isActive = false;
        if (game.interval) {
          clearInterval(game.interval);
        }
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
  console.log(`🌐 CORS разрешен для всех источников`);
});