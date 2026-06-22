// =============================================
// ПОЛУЧАЕМ ДАННЫЕ ИЗ URL
// =============================================

const params = new URLSearchParams(window.location.search);
const roomId = params.get('room');
const playerName = params.get('name');
const SERVER_URL = params.get('server');

if (!roomId || !playerName || !SERVER_URL) {
    alert('Ошибка: не хватает данных для подключения к игре');
    window.location.href = '/';
}

// =============================================
// ПОДКЛЮЧЕНИЕ К СЕРВЕРУ
// =============================================

const socket = io(SERVER_URL);
let myId = null;
let opponentId = null;
let myHistory = [];
let fullHistory = [];
let isMyTurn = false;
let gameState = null;

// =============================================
// DOM-ЭЛЕМЕНТЫ
// =============================================

const opponentLine = document.getElementById('opponentLine');
const memoryHint = document.getElementById('memoryHint');
const lineInput = document.getElementById('lineInput');
const sendBtn = document.getElementById('sendBtn');
const turnIndicator = document.getElementById('turnIndicator');
const roundTimer = document.getElementById('roundTimer');
const turnTimer = document.getElementById('turnTimer');
const roundBadge = document.getElementById('roundBadge');
const themeDisplay = document.getElementById('themeDisplay');
const myNameSpan = document.getElementById('myName');
const opponentNameSpan = document.getElementById('opponentName');
const arena = document.getElementById('arena');
const finalScreen = document.getElementById('finalScreen');
const poemBox = document.getElementById('poemBox');
const playAgainBtn = document.getElementById('playAgainBtn');

// =============================================
// ФУНКЦИЯ ОБНОВЛЕНИЯ ХОДА (ГЛАВНАЯ)
// =============================================

function updateTurn(myId, currentTurn) {
    isMyTurn = (currentTurn === myId);
    console.log(`🔄 Обновление хода: currentTurn=${currentTurn}, myId=${myId}, isMyTurn=${isMyTurn}`);
    
    if (isMyTurn) {
        turnIndicator.textContent = '🎯 Твой ход! Пиши!';
        turnIndicator.className = 'turn-indicator your-turn';
        lineInput.disabled = false;
        lineInput.className = 'active';
        sendBtn.disabled = false;
        lineInput.focus();
    } else {
        turnIndicator.textContent = '⏳ Ход соперника...';
        turnIndicator.className = 'turn-indicator opponent-turn';
        lineInput.disabled = true;
        lineInput.className = '';
        sendBtn.disabled = true;
    }
}

// =============================================
// СОЕДИНЕНИЕ С СЕРВЕРОМ
// =============================================

socket.on('connect', () => {
    console.log('✅ Подключен к серверу игры');
    myId = socket.id;
    console.log('📤 Отправляем join_game для комнаты:', roomId);
    socket.emit('join_game', { roomId, name: playerName });
});

// =============================================
// ОБРАБОТКА СОБЫТИЙ ОТ СЕРВЕРА
// =============================================

// 1. Получение состояния игры
socket.on('game_state', (data) => {
    console.log('📦 Получено состояние игры:', data);
    
    myId = data.myId;
    opponentId = data.opponentId;
    myNameSpan.textContent = data.myName;
    opponentNameSpan.textContent = data.opponentName;
    
    gameState = data.state;
    
    if (data.state.history) {
        fullHistory = data.state.history;
        myHistory = data.state.history
            .filter(line => line.authorId === myId)
            .map(line => line.text);
        updateMemoryHint();
    }
    
    if (data.state.lastLine) {
        opponentLine.textContent = data.state.lastLine;
        opponentLine.className = 'opponent-line';
    }
    
    updateTimers({
        timeLeft: data.state.timeLeft,
        turnTimeLeft: data.state.turnTimeLeft
    });
    
    // 🔥 ОБНОВЛЯЕМ ХОД СРАЗУ
    updateTurn(myId, data.state.currentTurn);
});

// 2. Смена хода (ОСНОВНОЕ СОБЫТИЕ)
socket.on('turn_changed', (data) => {
    console.log('🔄 Смена хода:', data);
    updateTurn(myId, data.currentTurn);
    updateTimers({ turnTimeLeft: data.turnTimeLeft });
});

// 3. Обновление таймеров
socket.on('game_tick', (data) => {
    updateTimers(data);
});

// 4. Новая строка
socket.on('new_line', (data) => {
    console.log('📝 Новая строка от', data.author, ':', data.lastLine);
    
    fullHistory.push({
        text: data.lastLine,
        author: data.author,
        authorId: data.authorId,
        timestamp: Date.now()
    });
    
    if (data.authorId === myId) {
        myHistory.push(data.lastLine);
        updateMemoryHint();
    }
    
    opponentLine.textContent = data.lastLine;
    opponentLine.className = 'opponent-line';
    
    updateTurn(myId, data.currentTurn);
    updateTimers({ turnTimeLeft: data.turnTimeLeft });
});

// 5. Пропуск хода
socket.on('turn_skipped', (data) => {
    console.log('⏭️ Пропуск хода:', data);
    fullHistory.push({
        text: `... (${data.playerName} пропустил ход) ...`,
        author: 'system',
        authorId: 'system',
        isSkip: true
    });
    showNotification(`⏭️ ${data.playerName} пропустил ход`);
    
    updateTurn(myId, data.currentTurn);
    updateTimers({ turnTimeLeft: data.turnTimeLeft });
});

// 6. Начало раунда
socket.on('round_start', (data) => {
    console.log('🔄 Начало раунда', data.round, 'Тема:', data.theme);
    
    roundBadge.textContent = `Раунд ${data.round}/3`;
    themeDisplay.textContent = `Тема: ${data.theme}`;
    opponentLine.textContent = 'Новый раунд! Начинайте...';
    opponentLine.className = 'opponent-line waiting';
    myHistory = [];
    updateMemoryHint();
    
    updateTurn(myId, data.currentTurn);
    updateTimers({
        timeLeft: data.timeLeft,
        turnTimeLeft: data.turnTimeLeft
    });
    
    showNotification(`🔄 Раунд ${data.round}! Тема: ${data.theme}`);
});

// 7. Завершение игры
socket.on('game_finished', (data) => {
    console.log('🏁 Игра завершена!');
    showFinalScreen(data);
});

// 8. Соперник вышел
socket.on('opponent_left', (data) => {
    console.log('🚪 Соперник покинул игру');
    showNotification('🚪 Соперник покинул игру');
    lineInput.disabled = true;
    sendBtn.disabled = true;
    turnIndicator.textContent = '❌ Игра прервана';
    turnIndicator.className = 'turn-indicator';
});

// 9. Ошибки
socket.on('error', (data) => {
    console.error('❌ Ошибка от сервера:', data);
    showNotification(`❌ ${data}`);
});

// 10. Ошибка подключения
socket.on('connect_error', (err) => {
    console.error('❌ Ошибка подключения к серверу:', err);
    showNotification('❌ Не удалось подключиться к серверу');
});

// =============================================
// ОБНОВЛЕНИЕ ИНТЕРФЕЙСА
// =============================================

function updateTimers(data) {
    if (data.timeLeft !== undefined) {
        const minutes = Math.floor(data.timeLeft / 60);
        const seconds = data.timeLeft % 60;
        roundTimer.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        if (data.timeLeft < 30) {
            roundTimer.className = 'value danger';
        } else if (data.timeLeft < 60) {
            roundTimer.className = 'value warning';
        } else {
            roundTimer.className = 'value';
        }
    }
    if (data.turnTimeLeft !== undefined) {
        turnTimer.textContent = data.turnTimeLeft;
        if (data.turnTimeLeft < 4) {
            turnTimer.className = 'value danger';
        } else if (data.turnTimeLeft < 7) {
            turnTimer.className = 'value warning';
        } else {
            turnTimer.className = 'value';
        }
    }
}

function updateMemoryHint() {
    if (myHistory.length === 0) {
        memoryHint.textContent = 'Твои последние: (пока ничего)';
        return;
    }
    const lastThree = myHistory.slice(-3);
    memoryHint.textContent = `📝 Твои последние: ${lastThree.join(' ... ')}`;
}

// =============================================
// ОТПРАВКА СТРОКИ
// =============================================

function sendLine() {
    const text = lineInput.value.trim();
    if (!text) {
        showNotification('✏️ Напиши что-нибудь!');
        return;
    }
    if (!isMyTurn) {
        showNotification('⏳ Сейчас не твой ход!');
        return;
    }
    console.log('📤 Отправляем строку:', text);
    socket.emit('submit_line', { roomId, text });
    lineInput.value = '';
    lineInput.focus();
}

lineInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendLine();
    }
});

sendBtn.addEventListener('click', sendLine);

// =============================================
// ФИНАЛЬНЫЙ ЭКРАН
// =============================================

function showFinalScreen(data) {
    arena.style.display = 'none';
    finalScreen.className = 'final-screen visible';

    let html = '';
    data.history.forEach(line => {
        let className = 'line';
        if (line.authorId === myId) className += ' you';
        else if (line.authorId === opponentId) className += ' opponent';
        else className += ' system';
        html += `<div class="${className}">${line.text}</div>`;
    });
    poemBox.innerHTML = html;
}

playAgainBtn.addEventListener('click', () => {
    window.location.href = '/';
});

// =============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =============================================

function showNotification(text) {
    console.log('📢', text);
    const container = document.getElementById('message-container') || document.body;
    const msg = document.createElement('div');
    msg.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #1a1a24;
        border: 1px solid #8b5cf6;
        color: #e8e8f0;
        padding: 10px 20px;
        border-radius: 12px;
        font-size: 14px;
        z-index: 9999;
        max-width: 90%;
        text-align: center;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    `;
    msg.textContent = text;
    document.body.appendChild(msg);
    setTimeout(() => {
        if (msg.parentNode) msg.remove();
    }, 4000);
}

// Выход из игры
document.getElementById('exitBtn').addEventListener('click', () => {
    if (confirm('Точно хочешь выйти из игры?')) {
        socket.disconnect();
        window.location.href = '/';
    }
});

console.log('🎮 Игровой экран загружен!');
console.log('🔗 Комната:', roomId);
console.log('👤 Игрок:', playerName);