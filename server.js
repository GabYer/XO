const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const BASE_DIR = __dirname;
const PUBLIC_DIR = path.join(BASE_DIR, "public");
const RUNTIME_CONFIG_PATH = path.join(BASE_DIR, ".xo-runtime.json");
const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 8000);
const CORS_ALLOW_ORIGIN = String(process.env.XO_CORS_ORIGIN || "").trim();
const MAX_MARKS_PER_PLAYER = 3;
const ROOM_CODE_LENGTH = 5;
const WINNING_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

const rooms = new Map();

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function randomId() {
  return crypto.randomBytes(16).toString("hex");
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function loadRuntimeBaseUrl() {
  const envBaseUrl = String(process.env.XO_BASE_URL || "").trim().replace(/\/$/, "");
  if (envBaseUrl) {
    return envBaseUrl;
  }

  if (!fs.existsSync(RUNTIME_CONFIG_PATH)) {
    return "";
  }

  try {
    const data = parseJson(fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
    return String(data.baseUrl || "").trim().replace(/\/$/, "");
  } catch (error) {
    return "";
  }
}

function playerSymbol(room, playerId) {
  for (const symbol of ["X", "O"]) {
    const player = room.players[symbol];
    if (player && player.id === playerId) {
      return symbol;
    }
  }
  return null;
}

function activeHint(room) {
  if (!room.showVanishHint) {
    return null;
  }
  const marks = room.marks[room.turn];
  if (marks.length < MAX_MARKS_PER_PLAYER) {
    return null;
  }
  return { symbol: room.turn, cell: marks[0] };
}

function canRestart(room) {
  return Boolean(room.winner || room.board.every((cell) => cell === null));
}

function roomPayload(room, playerId = null) {
  const symbol = playerSymbol(room, playerId);
  const player = symbol ? room.players[symbol] : null;
  return {
    code: room.code,
    version: room.version,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    board: room.board,
    marks: room.marks,
    turn: room.turn,
    winner: room.winner,
    winningLine: room.winningLine,
    showVanishHint: room.showVanishHint,
    activeHint: activeHint(room),
    status: !room.players.O ? "waiting" : room.winner ? "won" : "active",
    canRestart: canRestart(room),
    you: {
      id: player ? player.id : null,
      symbol,
    },
    players: {
      X: room.players.X
        ? {
            nickname: room.players.X.nickname,
            symbol: "X",
            online: room.players.X.onlineConnections > 0,
          }
        : null,
      O: room.players.O
        ? {
            nickname: room.players.O.nickname,
            symbol: "O",
            online: room.players.O.onlineConnections > 0,
          }
        : null,
    },
  };
}

function broadcastRoom(room) {
  for (const listener of [...room.listeners]) {
    try {
      listener.res.write(`data: ${JSON.stringify(roomPayload(room, listener.playerId))}\n\n`);
    } catch (error) {
      room.listeners.delete(listener);
    }
  }
}

function touchRoom(room) {
  room.updatedAt = nowTs();
  room.version += 1;
}

function checkWinner(board) {
  for (const line of WINNING_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line };
    }
  }
  return { winner: null, line: [] };
}

function createRoom(nickname, showVanishHint) {
  let code = "";
  while (!code) {
    const candidate = generateRoomCode();
    if (!rooms.has(candidate)) {
      code = candidate;
    }
  }

  const room = {
    code,
    version: 0,
    createdAt: nowTs(),
    updatedAt: nowTs(),
    showVanishHint: Boolean(showVanishHint),
    board: Array(9).fill(null),
    marks: { X: [], O: [] },
    turn: "X",
    winner: null,
    winningLine: [],
    players: {
      X: {
        id: randomId(),
        nickname,
        symbol: "X",
        onlineConnections: 0,
      },
      O: null,
    },
    listeners: new Set(),
  };

  rooms.set(code, room);
  return room;
}

function buildShareUrl(req, roomCode) {
  const configuredBaseUrl = loadRuntimeBaseUrl();
  if (configuredBaseUrl) {
    return `${configuredBaseUrl}/lobby?room=${roomCode}`;
  }
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${host}/lobby?room=${roomCode}`;
}

function writeCorsHeaders(res) {
  if (!CORS_ALLOW_ORIGIN) {
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
}

function sendJson(res, statusCode, payload) {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  writeCorsHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": raw.length,
    "Cache-Control": "no-store",
  });
  res.end(raw);
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  return map[extension] || "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  let publicPath = pathname;
  if (publicPath === "/") {
    publicPath = "/lobby.html";
  } else if (publicPath === "/room") {
    publicPath = "/room.html";
  } else if (publicPath === "/lobby") {
    publicPath = "/lobby.html";
  }

  const safePath = path.normalize(publicPath.replace(/^\/+/, ""));
  const filePath = path.resolve(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendJson(res, 404, { error: "Файл не найден." });
    return;
  }

  const raw = fs.readFileSync(filePath);
  writeCorsHeaders(res);
  res.writeHead(200, {
    "Content-Type": mimeType(filePath),
    "Content-Length": raw.length,
    "Cache-Control": "no-store",
  });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve(raw ? parseJson(raw, null) : {});
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    writeCorsHeaders(res);
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Length": "0",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, rooms: rooms.size, port: PORT });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readBody(req);
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { error: "Некорректный JSON." });
      return;
    }

    const nickname = String(body.nickname || "").trim().slice(0, 24);
    if (nickname.length < 2) {
      sendJson(res, 400, { error: "Ник должен быть не короче 2 символов." });
      return;
    }

    const room = createRoom(nickname, body.showVanishHint !== false);
    sendJson(res, 201, {
      playerId: room.players.X.id,
      room: roomPayload(room, room.players.X.id),
      shareUrl: buildShareUrl(req, room.code),
    });
    return;
  }

  if (!url.pathname.startsWith("/api/rooms/")) {
    sendJson(res, 404, { error: "Маршрут не найден." });
    return;
  }

  const parts = url.pathname.replace(/^\/api\/rooms\//, "").split("/").filter(Boolean);
  const room = rooms.get(normalizeCode(parts[0]));
  const action = parts[1] || "";

  if (!room) {
    sendJson(res, 404, { error: "Комната не найдена." });
    return;
  }

  if (req.method === "GET" && !action) {
    sendJson(res, 200, roomPayload(room, url.searchParams.get("playerId")));
    return;
  }

  if (req.method === "POST" && action === "join") {
    const body = await readBody(req);
    const nickname = String(body?.nickname || "").trim().slice(0, 24);
    if (nickname.length < 2) {
      sendJson(res, 400, { error: "Ник должен быть не короче 2 символов." });
      return;
    }
    if (room.players.O) {
      sendJson(res, 409, { error: "Комната уже заполнена." });
      return;
    }

    const playerId = randomId();
    room.players.O = {
      id: playerId,
      nickname,
      symbol: "O",
      onlineConnections: 0,
    };
    touchRoom(room);
    broadcastRoom(room);
    sendJson(res, 200, {
      playerId,
      room: roomPayload(room, playerId),
      shareUrl: buildShareUrl(req, room.code),
    });
    return;
  }

  if (req.method === "POST" && action === "move") {
    const body = await readBody(req);
    const playerId = body?.playerId;
    const cell = Number(body?.cell);
    const symbol = playerSymbol(room, playerId);

    if (!Number.isInteger(cell) || cell < 0 || cell > 8) {
      sendJson(res, 400, { error: "Некорректная клетка." });
      return;
    }
    if (!symbol) {
      sendJson(res, 403, { error: "Игрок не найден в комнате." });
      return;
    }
    if (!room.players.O) {
      sendJson(res, 409, { error: "Нужен второй игрок." });
      return;
    }
    if (room.winner) {
      sendJson(res, 409, { error: "Партия уже завершена." });
      return;
    }
    if (room.turn !== symbol) {
      sendJson(res, 409, { error: "Сейчас ход другого игрока." });
      return;
    }
    if (room.board[cell] !== null) {
      sendJson(res, 409, { error: "Клетка уже занята." });
      return;
    }

    room.board[cell] = symbol;
    room.marks[symbol].push(cell);
    if (room.marks[symbol].length > MAX_MARKS_PER_PLAYER) {
      const removed = room.marks[symbol].shift();
      room.board[removed] = null;
    }

    const result = checkWinner(room.board);
    if (result.winner) {
      room.winner = result.winner;
      room.winningLine = result.line;
    } else {
      room.turn = symbol === "X" ? "O" : "X";
    }

    touchRoom(room);
    broadcastRoom(room);
    sendJson(res, 200, { room: roomPayload(room, playerId) });
    return;
  }

  if (req.method === "POST" && action === "restart") {
    const body = await readBody(req);
    if (!playerSymbol(room, body?.playerId)) {
      sendJson(res, 403, { error: "Игрок не найден в комнате." });
      return;
    }
    if (!canRestart(room)) {
      sendJson(res, 409, { error: "Новая партия доступна после победы или до первого хода." });
      return;
    }

    room.board = Array(9).fill(null);
    room.marks = { X: [], O: [] };
    room.turn = "X";
    room.winner = null;
    room.winningLine = [];
    touchRoom(room);
    broadcastRoom(room);
    sendJson(res, 200, { room: roomPayload(room, body.playerId) });
    return;
  }

  if (req.method === "GET" && action === "stream") {
    const playerId = url.searchParams.get("playerId");
    const listener = { playerId, res, ping: null };
    room.listeners.add(listener);

    const symbol = playerSymbol(room, playerId);
    if (symbol) {
      room.players[symbol].onlineConnections += 1;
      touchRoom(room);
    }

    writeCorsHeaders(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate, no-transform",
      Pragma: "no-cache",
      Expires: "0",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    req.socket?.setTimeout(0);
    res.socket?.setNoDelay(true);
    res.socket?.setKeepAlive(true, 15000);
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    res.write("retry: 1500\n");
    res.write(`: ${" ".repeat(2048)}\n\n`);
    res.write(`data: ${JSON.stringify(roomPayload(room, playerId))}\n\n`);
    broadcastRoom(room);

    listener.ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch (error) {
        clearInterval(listener.ping);
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(listener.ping);
      room.listeners.delete(listener);
      const leavingSymbol = playerSymbol(room, playerId);
      if (leavingSymbol && room.players[leavingSymbol].onlineConnections > 0) {
        room.players[leavingSymbol].onlineConnections -= 1;
        touchRoom(room);
        broadcastRoom(room);
      }
    });
    return;
  }

  sendJson(res, 404, { error: "Маршрут не найден." });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: "Внутренняя ошибка сервера." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`XO Node server started on http://localhost:${PORT}`);
});
