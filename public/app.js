const boardElement = document.getElementById("board");
const roomSection = document.getElementById("room-section");
const createForm = document.getElementById("create-form");
const joinForm = document.getElementById("join-form");
const createNicknameInput = document.getElementById("create-nickname");
const joinNicknameInput = document.getElementById("join-nickname");
const joinCodeInput = document.getElementById("join-code");
const showHintInput = document.getElementById("show-hint");
const roomCodeLabel = document.getElementById("room-code-label");
const statusText = document.getElementById("status-text");
const restartButton = document.getElementById("restart-game");
const copyCodeButton = document.getElementById("copy-code");
const copyLinkButton = document.getElementById("copy-link");
const leaveRoomButton = document.getElementById("leave-room");
const toastElement = document.getElementById("toast");
const networkHintElement = document.getElementById("network-hint");

const playerNameElements = {
  X: document.getElementById("player-x-name"),
  O: document.getElementById("player-o-name"),
};
const playerMetaElements = {
  X: document.getElementById("player-x-meta"),
  O: document.getElementById("player-o-meta"),
};
const playerCardElements = {
  X: document.getElementById("player-x-card"),
  O: document.getElementById("player-o-card"),
};

const STORAGE_KEY = "xo-drift-session";

const state = {
  room: null,
  playerId: null,
  shareUrl: null,
  eventSource: null,
  reconnectTimer: null,
};

function saveSession() {
  if (!state.room || !state.playerId) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      roomCode: state.room.code,
      playerId: state.playerId,
    }),
  );
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch (error) {
    return null;
  }
}

function clearSession() {
  state.room = null;
  state.playerId = null;
  state.shareUrl = null;
  saveSession();
  closeStream();
  roomSection.classList.add("hidden");
  history.replaceState({}, "", "/");
}

function closeStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function showToast(message) {
  toastElement.textContent = message;
  toastElement.classList.remove("hidden");
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    toastElement.classList.add("hidden");
  }, 2400);
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Ошибка запроса.");
  }

  return data;
}

function buildShareUrl(code) {
  const configuredBaseUrl = window.XO_RUNTIME?.baseUrl?.trim?.();
  if (configuredBaseUrl) {
    return `${configuredBaseUrl.replace(/\/$/, "")}/?room=${code}`;
  }
  return `${window.location.origin}/?room=${code}`;
}

function openRoom(data) {
  state.room = data.room;
  state.playerId = data.playerId || state.playerId;
  state.shareUrl = buildShareUrl(state.room.code);
  saveSession();
  roomSection.classList.remove("hidden");
  history.replaceState({}, "", `/?room=${state.room.code}`);
  renderRoom();
  connectStream();
}

function updateRoom(room) {
  state.room = room;
  if (!state.shareUrl && room?.code) {
    state.shareUrl = buildShareUrl(room.code);
  }
  if (room?.you?.id) {
    state.playerId = room.you.id;
    saveSession();
  }
  renderRoom();
}

function getCurrentPlayer() {
  if (!state.room || !state.room.you?.symbol) {
    return null;
  }
  return state.room.players[state.room.you.symbol];
}

function getStatusMessage() {
  if (!state.room) {
    return "Создай комнату или войди по коду.";
  }

  const { players, turn, winner, showVanishHint, activeHint } = state.room;
  const you = getCurrentPlayer();
  const turnPlayer = players[turn];
  const winnerPlayer = winner ? players[winner] : null;

  if (!players.O) {
    return "Комната готова. Ждём второго игрока по коду или ссылке.";
  }

  if (winnerPlayer) {
    const isYou = winner === state.room.you?.symbol;
    return `${winnerPlayer.nickname} выиграл${isYou ? " и это ты." : "."} Можно начать новую партию.`;
  }

  const prefix = you && you.symbol === turn ? "Твой ход." : `Сейчас ходит ${turnPlayer.nickname}.`;
  if (showVanishHint && activeHint) {
    return `${prefix} Подсветка на доске показывает фигуру ${activeHint.symbol}, которая исчезнет следующей.`;
  }

  return prefix;
}

function renderPlayers() {
  for (const symbol of ["X", "O"]) {
    const player = state.room.players[symbol];
    const isCurrent = state.room.you?.symbol === symbol;
    playerCardElements[symbol].classList.toggle("current-player", Boolean(isCurrent));

    if (!player) {
      playerNameElements[symbol].textContent = symbol === "X" ? "Ожидание..." : "Свободное место";
      playerMetaElements[symbol].textContent =
        symbol === "X" ? "Создатель комнаты" : "Друг может зайти по коду или ссылке";
      continue;
    }

    const onlineText = player.online ? "в сети" : "не в сети";
    const meText = isCurrent ? " • это ты" : "";
    playerNameElements[symbol].textContent = player.nickname;
    playerMetaElements[symbol].textContent = `${symbol} • ${onlineText}${meText}`;
  }
}

function renderBoard() {
  boardElement.innerHTML = "";

  const activeHintCell = state.room?.showVanishHint ? state.room?.activeHint?.cell : null;
  const isMyTurn = state.room?.you?.symbol === state.room?.turn;
  const gameActive = state.room?.status === "active";

  state.room.board.forEach((value, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cell";
    button.dataset.index = String(index);
    button.disabled = !isMyTurn || !gameActive || value !== null;
    button.textContent = value || "";

    if (value === "X") {
      button.classList.add("cell-x");
    }
    if (value === "O") {
      button.classList.add("cell-o");
    }
    if (state.room.winningLine.includes(index)) {
      button.classList.add("cell-winning");
    }
    if (activeHintCell === index) {
      button.classList.add("cell-hint");
      const badge = document.createElement("span");
      badge.className = "hint-badge";
      badge.textContent = "исчезнет";
      button.appendChild(badge);
    }

    button.addEventListener("click", () => submitMove(index));
    boardElement.appendChild(button);
  });
}

function renderRoom() {
  if (!state.room) {
    return;
  }

  roomCodeLabel.textContent = state.room.code;
  networkHintElement.textContent = state.shareUrl
    ? `Для другого компьютера в этой сети: ${state.shareUrl}`
    : "Открой игру по локальному IP-адресу этого компьютера.";
  statusText.textContent = getStatusMessage();
  restartButton.disabled = !state.room.canRestart;
  renderPlayers();
  renderBoard();
}

function connectStream() {
  closeStream();

  if (!state.room?.code) {
    return;
  }

  const params = new URLSearchParams();
  if (state.playerId) {
    params.set("playerId", state.playerId);
  }
  const query = params.toString() ? `?${params.toString()}` : "";
  const stream = new EventSource(`/api/rooms/${state.room.code}/stream${query}`);
  state.eventSource = stream;

  stream.onmessage = (event) => {
    const room = JSON.parse(event.data);
    updateRoom(room);
  };

  stream.onerror = () => {
    statusText.textContent = "Связь обновляется. Пытаемся переподключиться...";
    stream.close();
    state.eventSource = null;
    if (!state.reconnectTimer) {
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        connectStream();
      }, 1500);
    }
  };
}

async function hydrateExistingRoom(roomCode, playerId) {
  const params = new URLSearchParams();
  if (playerId) {
    params.set("playerId", playerId);
  }

  const query = params.toString() ? `?${params.toString()}` : "";
  const room = await apiRequest(`/api/rooms/${roomCode}${query}`);
  state.room = room;
  if (room.you?.id) {
    state.playerId = room.you.id;
  } else if (playerId) {
    state.playerId = playerId;
  }
  state.shareUrl = buildShareUrl(room.code);
  roomSection.classList.remove("hidden");
  history.replaceState({}, "", `/?room=${room.code}`);
  renderRoom();
  connectStream();
}

async function createRoom(event) {
  event.preventDefault();
  const nickname = createNicknameInput.value.trim();
  if (nickname.length < 2) {
    showToast("Ник должен быть не короче 2 символов.");
    return;
  }

  try {
    const data = await apiRequest("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        nickname,
        showVanishHint: showHintInput.checked,
      }),
    });
    openRoom(data);
    showToast("Комната создана.");
  } catch (error) {
    showToast(error.message);
  }
}

async function joinRoom(event) {
  event.preventDefault();
  const nickname = joinNicknameInput.value.trim();
  const code = joinCodeInput.value.trim().toUpperCase();
  if (nickname.length < 2 || code.length < 5) {
    showToast("Заполни ник и корректный код комнаты.");
    return;
  }

  try {
    const data = await apiRequest(`/api/rooms/${code}/join`, {
      method: "POST",
      body: JSON.stringify({ nickname }),
    });
    openRoom(data);
    showToast("Ты в комнате.");
  } catch (error) {
    showToast(error.message);
  }
}

async function submitMove(cell) {
  if (!state.room || !state.playerId) {
    return;
  }

  try {
    const data = await apiRequest(`/api/rooms/${state.room.code}/move`, {
      method: "POST",
      body: JSON.stringify({
        playerId: state.playerId,
        cell,
      }),
    });
    updateRoom(data.room);
  } catch (error) {
    showToast(error.message);
  }
}

async function restartGame() {
  if (!state.room || !state.playerId) {
    return;
  }

  try {
    const data = await apiRequest(`/api/rooms/${state.room.code}/restart`, {
      method: "POST",
      body: JSON.stringify({
        playerId: state.playerId,
      }),
    });
    updateRoom(data.room);
    showToast("Новая партия запущена.");
  } catch (error) {
    showToast(error.message);
  }
}

async function copyText(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
    showToast(successMessage);
  } catch (error) {
    showToast("Не удалось скопировать.");
  }
}

async function bootstrap() {
  createForm.addEventListener("submit", createRoom);
  joinForm.addEventListener("submit", joinRoom);
  restartButton.addEventListener("click", restartGame);
  leaveRoomButton.addEventListener("click", () => {
    clearSession();
    showToast("Ты вышел из комнаты.");
  });
  copyCodeButton.addEventListener("click", () => {
    if (state.room) {
      copyText(state.room.code, "Код комнаты скопирован.");
    }
  });
  copyLinkButton.addEventListener("click", () => {
    if (state.shareUrl) {
      copyText(state.shareUrl, "Ссылка приглашения скопирована.");
    }
  });

  for (let index = 0; index < 9; index += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cell";
    button.disabled = true;
    boardElement.appendChild(button);
  }

  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = (urlParams.get("room") || "").trim().toUpperCase();
  const stored = loadSession();

  if (roomFromUrl) {
    joinCodeInput.value = roomFromUrl;
  }

  const candidateRoom = roomFromUrl || stored?.roomCode;
  const candidatePlayerId = candidateRoom === stored?.roomCode ? stored?.playerId : null;

  if (!candidateRoom) {
    return;
  }

  try {
    await hydrateExistingRoom(candidateRoom, candidatePlayerId);
  } catch (error) {
    if (candidatePlayerId) {
      localStorage.removeItem(STORAGE_KEY);
    }
    statusText.textContent = "Комната не найдена. Создай новую или введи другой код.";
  }
}

bootstrap();
