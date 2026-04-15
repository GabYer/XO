const {
  buildPageUrl,
  saveSession,
  loadSession,
  clearSession,
  apiRequest,
  copyText,
  buildApiUrl,
} = window.XOCommon;

const roomTitle = document.getElementById("room-code-label");
const statusText = document.getElementById("status-text");
const boardElement = document.getElementById("board");
const copyCodeButton = document.getElementById("copy-code");
const copyLinkButton = document.getElementById("copy-link");
const toLobbyButton = document.getElementById("to-lobby");
const forgetRoomButton = document.getElementById("forget-room");
const restartButton = document.getElementById("restart-game");
const shareLinkText = document.getElementById("share-link");
const toastElement = document.getElementById("toast");

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

const state = {
  room: null,
  playerId: null,
  eventSource: null,
  reconnectTimer: null,
};

function showToast(message) {
  toastElement.textContent = message;
  toastElement.classList.remove("hidden");
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    toastElement.classList.add("hidden");
  }, 2800);
}

function shareLobbyUrl(roomCode) {
  return buildPageUrl("lobby", { room: roomCode });
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

function currentPlayer() {
  if (!state.room || !state.room.you?.symbol) {
    return null;
  }
  return state.room.players[state.room.you.symbol];
}

function statusMessage() {
  if (!state.room) {
    return "Komnata zagruzhaetsya...";
  }

  const { players, turn, winner, showVanishHint, activeHint } = state.room;
  const you = currentPlayer();
  const turnPlayer = players[turn];
  const winnerPlayer = winner ? players[winner] : null;

  if (!players.O) {
    return "Zhdyom vtorogo igroka. Otprav ssylku ili kod komnaty.";
  }

  if (winnerPlayer) {
    return `Pobedil ${winnerPlayer.nickname}. Mozhno nachat novuyu partiyu.`;
  }

  const prefix = you && you.symbol === turn ? "Tvoy hod." : `Hodit ${turnPlayer.nickname}.`;
  if (showVanishHint && activeHint) {
    return `${prefix} Podsvetka pokazyvaet figuru ${activeHint.symbol}, kotoraya ischeznet sleduyushchey.`;
  }
  return prefix;
}

function renderPlayers() {
  for (const symbol of ["X", "O"]) {
    const player = state.room.players[symbol];
    const isCurrent = state.room.you?.symbol === symbol;
    playerCardElements[symbol].classList.toggle("current-player", Boolean(isCurrent));

    if (!player) {
      playerNameElements[symbol].textContent = symbol === "X" ? "Ozhidanie..." : "Svobodnoe mesto";
      playerMetaElements[symbol].textContent =
        symbol === "X" ? "Sozdatel komnaty" : "Drug mozhet zayti po ssylke ili kodu";
      continue;
    }

    const onlineText = player.online ? "v seti" : "ne v seti";
    const meText = isCurrent ? " - eto ty" : "";
    playerNameElements[symbol].textContent = player.nickname;
    playerMetaElements[symbol].textContent = `${symbol} - ${onlineText}${meText}`;
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
      badge.textContent = "ischeznet";
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

  roomTitle.textContent = state.room.code;
  shareLinkText.textContent = shareLobbyUrl(state.room.code);
  statusText.textContent = statusMessage();
  restartButton.disabled = !state.room.canRestart;
  renderPlayers();
  renderBoard();
}

function connectStream() {
  closeStream();
  if (!state.room?.code) {
    return;
  }

  const query = new URLSearchParams();
  if (state.playerId) {
    query.set("playerId", state.playerId);
  }

  const streamUrl = `${buildApiUrl(`api/rooms/${state.room.code}/stream`)}${query.toString() ? `?${query}` : ""}`;
  state.eventSource = new EventSource(streamUrl);

  state.eventSource.onmessage = (event) => {
    const room = JSON.parse(event.data);
    state.room = room;
    if (room.you?.id) {
      state.playerId = room.you.id;
      saveSession({
        roomCode: room.code,
        playerId: room.you.id,
      });
    }
    renderRoom();
  };

  state.eventSource.onerror = () => {
    closeStream();
    statusText.textContent = "Svyaz obnovlyaetsya. Popytka perepodklyucheniya...";
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connectStream();
    }, 1500);
  };
}

async function submitMove(cell) {
  try {
    const data = await apiRequest(`api/rooms/${state.room.code}/move`, {
      method: "POST",
      body: JSON.stringify({
        playerId: state.playerId,
        cell,
      }),
    });
    state.room = data.room;
    renderRoom();
  } catch (error) {
    showToast(error.message);
  }
}

async function restartGame() {
  try {
    const data = await apiRequest(`api/rooms/${state.room.code}/restart`, {
      method: "POST",
      body: JSON.stringify({
        playerId: state.playerId,
      }),
    });
    state.room = data.room;
    renderRoom();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadRoom() {
  const roomFromUrl = new URLSearchParams(window.location.search).get("room");
  const session = loadSession();
  const roomCode = roomFromUrl || session?.roomCode;
  const playerId = roomCode === session?.roomCode ? session?.playerId : null;

  if (!roomCode) {
    window.location.href = buildPageUrl("lobby");
    return;
  }

  try {
    const room = await apiRequest(`api/rooms/${roomCode}${playerId ? `?playerId=${playerId}` : ""}`);
    state.room = room;
    state.playerId = room.you?.id || playerId || null;
    if (state.playerId) {
      saveSession({
        roomCode: room.code,
        playerId: state.playerId,
      });
    }
    renderRoom();
    connectStream();
  } catch (error) {
    showToast(error.message);
    setTimeout(() => {
      window.location.href = buildPageUrl("lobby", { room: roomCode });
    }, 900);
  }
}

function bootstrap() {
  copyCodeButton.addEventListener("click", async () => {
    try {
      await copyText(state.room.code);
      showToast("Kod komnaty skopirovan.");
    } catch (error) {
      showToast("Ne udalos skopirovat kod.");
    }
  });

  copyLinkButton.addEventListener("click", async () => {
    try {
      await copyText(shareLobbyUrl(state.room.code));
      showToast("Ssylka dlya druga skopirovana.");
    } catch (error) {
      showToast("Ne udalos skopirovat ssylku.");
    }
  });

  toLobbyButton.addEventListener("click", () => {
    window.location.href = buildPageUrl("lobby");
  });

  forgetRoomButton.addEventListener("click", () => {
    clearSession();
    window.location.href = buildPageUrl("lobby");
  });

  restartButton.addEventListener("click", restartGame);
  loadRoom();
}

bootstrap();
