const {
  buildPageUrl,
  saveSession,
  loadSession,
  clearSession,
  apiRequest,
} = window.XOCommon;

const createForm = document.getElementById("create-form");
const joinForm = document.getElementById("join-form");
const showHintInput = document.getElementById("show-hint");
const joinCodeInput = document.getElementById("join-code");
const savedCard = document.getElementById("saved-room-card");
const savedRoomCode = document.getElementById("saved-room-code");
const resumeRoomButton = document.getElementById("resume-room");
const forgetRoomButton = document.getElementById("forget-room");
const toastElement = document.getElementById("toast");

function showToast(message) {
  toastElement.textContent = message;
  toastElement.classList.remove("hidden");
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    toastElement.classList.add("hidden");
  }, 2800);
}

function renderSavedRoom() {
  const session = loadSession();
  if (!session?.roomCode) {
    savedCard.classList.add("hidden");
    return;
  }

  savedCard.classList.remove("hidden");
  savedRoomCode.textContent = session.roomCode;
}

async function handleCreate(event) {
  event.preventDefault();
  const formData = new FormData(createForm);
  const nickname = String(formData.get("nickname") || "").trim();
  if (nickname.length < 2) {
    showToast("Nik dolzhen byt ne koroche 2 simvolov.");
    return;
  }

  try {
    const data = await apiRequest("api/rooms", {
      method: "POST",
      body: JSON.stringify({
        nickname,
        showVanishHint: showHintInput.checked,
      }),
    });

    saveSession({
      roomCode: data.room.code,
      playerId: data.playerId,
    });

    window.location.href = buildPageUrl("room", { room: data.room.code });
  } catch (error) {
    showToast(error.message);
  }
}

async function handleJoin(event) {
  event.preventDefault();
  const formData = new FormData(joinForm);
  const nickname = String(formData.get("nickname") || "").trim();
  const code = String(formData.get("code") || "").trim().toUpperCase();
  if (nickname.length < 2 || code.length < 5) {
    showToast("Zapolni nik i korrektnyy kod komnaty.");
    return;
  }

  try {
    const data = await apiRequest(`api/rooms/${code}/join`, {
      method: "POST",
      body: JSON.stringify({ nickname }),
    });

    saveSession({
      roomCode: data.room.code,
      playerId: data.playerId,
    });

    window.location.href = buildPageUrl("room", { room: data.room.code });
  } catch (error) {
    showToast(error.message);
  }
}

function bootstrap() {
  createForm.addEventListener("submit", handleCreate);
  joinForm.addEventListener("submit", handleJoin);

  const roomFromUrl = new URLSearchParams(window.location.search).get("room");
  if (roomFromUrl) {
    joinCodeInput.value = roomFromUrl.trim().toUpperCase();
  }

  resumeRoomButton.addEventListener("click", () => {
    const session = loadSession();
    if (session?.roomCode) {
      window.location.href = buildPageUrl("room", { room: session.roomCode });
    }
  });

  forgetRoomButton.addEventListener("click", () => {
    clearSession();
    renderSavedRoom();
    showToast("Sohranennaya komnata udalena.");
  });

  renderSavedRoom();
}

bootstrap();
