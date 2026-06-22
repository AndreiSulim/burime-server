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
    origin: "*", // разрешаем подключения с любых сайтов (потом ограничим)
    methods: ["GET", "POST"]
  }
});

// =============================================
// ХРАНЕНИЕ ДАННЫХ В ПАМЯТИ СЕРВЕРА
// =============================================

const waitingQueue = [];        // Очередь игроков, которые ищут соперника
const activeGames = new Map();  // Активные игры: roomId -> gameData

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

  // Забираем первых двух из очереди
  const player1 = waitingQueue.shift();
  const player2 = waitingQueue.shift();

  const roomId = generateRoomId();
  const theme = getRandomTheme();

  // Создаём игровое состояние
  const gameData = {
    players: [player1, player2],
    currentTurn: player1.id,
    round: 1,
    timeLeft: 180,          // 3 минуты на раунд
    turnTimeLeft: 10,       // 10 секунд на ход
    history: [],
    lastLine: null,
    theme: theme,
    isActive: true,
    interval: null,
    roundCount: 1
  };

  activeGames.set(roomId, gameData);

  // Подключаем игроков к комнате Socket.io
  player1.socket.join(roomId);
  player2.socket.join(roomId);

  // Отправляем обоим игрокам событие о начале игры
  io.to(roomId).emit('game_started', {
    roomId: roomId,
    opponent: player2.name,
    theme: theme,
    round: 1,
    currentTurn: player1.id,
    youAre: 'player1'
  });

  // Отправляем второму игроку, что он player2
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
// ИГРОВОЙ ЦИКЛ (Таймеры)
// =============================================

function startGameLoop(roomId) {
  const game = activeGames.get(roomId);
  if (!game) return;

  // Останавливаем старый интервал, если был
  if (game.interval) {
    clearInterval(game.interval);
  }

  game.interval = setInterval(() => {
    // Проверяем, активна ли игра
    if (!game.isActive) {
      clearInterval(game.interval);
      return;
    }

    // Обновляем таймеры
    game.timeLeft--;
    game.turnTimeLeft--;

    // Отправляем тик всем в комнате
    io.to(roomId).emit('game_tick', {
      timeLeft: game.timeLeft,
      turnTimeLeft: game.turnTimeLeft,
      currentTurn: game.currentTurn
    });

    // Проверка: истекло ли время хода (10 секунд)
    if (game.turnTimeLeft <= 0) {
      handleTurnTimeout(roomId);
    }

    // Проверка: истекло ли время раунда (3 минуты)
    if (game.timeLeft <= 0) {
      handleRoundEnd(roomId);
    }

  }, 1000);
}

// =============================================
// ОБРАБОТКА ПРОПУСКА ХОДА
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
      isSkip: true,
      timestamp: Date.now()
    });
  }

  // Переключаем ход
  game.currentTurn = opponent.id;
  game.turnTimeLeft = 10;

  io.to(roomId).emit('turn_skipped', {
    message: `${currentPlayer ? currentPlayer.name : 'Игрок'} пропустил ход`,
    currentTurn: game.currentTurn,
    turnTimeLeft: game.turnTimeLeft
  });
}

// =============================================
// ОКОНЧАНИЕ РАУНДА
// =============================================

function handleRoundEnd(roomId) {
  const game = activeGames.get(roomId);
  if (!game || !game.isActive) return;

  // Проверяем, был ли это третий раунд
  if (game.round >= 3) {
    finishGame(roomId);
    return;
  }

  // Переход к следующему раунду
  game.round++;
  game.timeLeft = 180;
  game.turnTimeLeft = 10;
  game.lastLine = null;

  // Меняем, кто начинает (для справедливости)
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

  // Перезапускаем цикл
  startGameLoop(roomId);
}

// =============================================
// ЗАВЕРШЕНИЕ ИГРЫ (Финал)
// =============================================

function finishGame(roomId) {
  const game = activeGames.get(roomId);
  if (!game) return;

  game.isActive = false;

  if (game.interval) {
    clearInterval(game.interval);
    game.interval = null;
  }

  // Формируем итоговый стих
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

  // Через 15 секунд удаляем игру
  setTimeout(() => {
    const gameToDelete = activeGames.get(roomId);
    if (gameToDelete) {
      gameToDelete.players.forEach(p => {
        p.socket.leave(roomId);
      });
      activeGames.delete(roomId);
    }
  }, 15000);
}

// =============================================
// ОБРАБОТЧИКИ СОКЕТОВ
// =============================================

io.on('connection', (socket) => {
  console.log('🟢 Подключился игрок:', socket.id);

  // Игрок хочет найти игру
  socket.on('find_game', (data) => {
    const playerName = data?.name?.trim() || 'Аноним';

    // Проверяем, не в очереди ли уже этот игрок
    const alreadyWaiting = waitingQueue.some(p => p.id === socket.id);
    if (alreadyWaiting) {
      socket.emit('error', 'Вы уже в очереди');
      return;
    }

    // Добавляем в очередь
    waitingQueue.push({
      id: socket.id,
      name: playerName,
      socket: socket,
      joinedAt: Date.now()
    });

    socket.emit('queued', { message: 'Вы в очереди. Ищем соперника...' });

    // Пытаемся найти пару
    tryMatchPlayers();
  });

  // Игрок отправляет строку
  socket.on('submit_line', (data) => {
    const { roomId, text } = data;
    const game = activeGames.get(roomId);

    if (!game || !game.isActive) {
      socket.emit('error', 'Игра не найдена или уже завершена');
      return;
    }

    // Проверка: чей сейчас ход?
    if (socket.id !== game.currentTurn) {
      socket.emit('error', 'Сейчас не твой ход');
      return;
    }

    // Проверка: не пустой ли текст?
    if (!text || text.trim().length === 0) {
      socket.emit('error', 'Строка не может быть пустой');
      return;
    }

    // Принимаем строку
    const player = game.players.find(p => p.id === socket.id);
    const lineData = {
      text: text.trim(),
      author: player ? player.name : 'Игрок',
      authorId: socket.id,
      timestamp: Date.now()
    };

    game.history.push(lineData);
    game.lastLine = text.trim();

    // Переключаем ход на соперника
    const opponent = game.players.find(p => p.id !== socket.id);
    game.currentTurn = opponent.id;
    game.turnTimeLeft = 10;

    // Отправляем обновление всем в комнате
    io.to(roomId).emit('new_line', {
      lastLine: game.lastLine,
      currentTurn: game.currentTurn,
      turnTimeLeft: game.turnTimeLeft,
      author: lineData.author
    });
  });

  // Игрок отключается
  socket.on('disconnect', () => {
    console.log('🔴 Отключился игрок:', socket.id);

    // Удаляем из очереди
    const queueIndex = waitingQueue.findIndex(p => p.id === socket.id);
    if (queueIndex !== -1) {
      waitingQueue.splice(queueIndex, 1);
    }

    // Проверяем, не был ли игрок в активной игре
    for (const [roomId, game] of activeGames) {
      const playerInGame = game.players.some(p => p.id === socket.id);
      if (playerInGame) {
        // Уведомляем другого игрока
        io.to(roomId).emit('opponent_left', {
          message: 'Соперник покинул игру'
        });
        game.isActive = false;
        if (game.interval) {
          clearInterval(game.interval);
        }
        activeGames.delete(roomId);
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