import json
import os
import queue
import random
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from mimetypes import guess_type
from urllib.parse import parse_qs, unquote, urlparse


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
RUNTIME_CONFIG_PATH = os.path.join(BASE_DIR, ".xo-runtime.json")
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8000"))
MAX_MARKS_PER_PLAYER = 3
ROOM_CODE_LENGTH = 5
CORS_ALLOW_ORIGIN = os.environ.get("XO_CORS_ORIGIN", "").strip()
WINNING_LINES = (
    (0, 1, 2),
    (3, 4, 5),
    (6, 7, 8),
    (0, 3, 6),
    (1, 4, 7),
    (2, 5, 8),
    (0, 4, 8),
    (2, 4, 6),
)


def now_ts():
    return int(time.time())


def generate_room_code():
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(alphabet) for _ in range(ROOM_CODE_LENGTH))


def normalize_code(value):
    return (value or "").strip().upper()


def check_winner(board):
    for line in WINNING_LINES:
        a, b, c = line
        if board[a] and board[a] == board[b] == board[c]:
            return board[a], list(line)
    return None, []


def load_runtime_base_url():
    configured_base_url = os.environ.get("XO_BASE_URL", "").strip().rstrip("/")
    if configured_base_url:
        return configured_base_url

    if not os.path.isfile(RUNTIME_CONFIG_PATH):
        return ""

    try:
        with open(RUNTIME_CONFIG_PATH, "r", encoding="utf-8-sig") as config_file:
            data = json.load(config_file)
    except (OSError, ValueError):
        return ""

    return str(data.get("baseUrl", "")).strip().rstrip("/")


class GameRoom:
    def __init__(self, code, host_nickname, show_vanish_hint):
        host_id = uuid.uuid4().hex
        self.code = code
        self.lock = threading.Lock()
        self.listeners = []
        self.version = 0
        self.created_at = now_ts()
        self.updated_at = self.created_at
        self.show_vanish_hint = bool(show_vanish_hint)
        self.board = [None] * 9
        self.marks = {"X": [], "O": []}
        self.turn = "X"
        self.winner = None
        self.winning_line = []
        self.players = {
            "X": {
                "id": host_id,
                "nickname": host_nickname,
                "symbol": "X",
                "online_connections": 0,
            },
            "O": None,
        }

    def player_symbol(self, player_id):
        for symbol, player in self.players.items():
            if player and player["id"] == player_id:
                return symbol
        return None

    def active_hint(self):
        if not self.show_vanish_hint:
            return None
        marks = self.marks[self.turn]
        if len(marks) < MAX_MARKS_PER_PLAYER:
            return None
        return {"symbol": self.turn, "cell": marks[0]}

    def can_restart(self):
        return bool(self.winner or not any(self.board))

    def to_payload(self, player_id=None):
        current_symbol = self.player_symbol(player_id)
        current_player = self.players.get(current_symbol) if current_symbol else None
        return {
            "code": self.code,
            "version": self.version,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "board": self.board,
            "marks": self.marks,
            "turn": self.turn,
            "winner": self.winner,
            "winningLine": self.winning_line,
            "showVanishHint": self.show_vanish_hint,
            "activeHint": self.active_hint(),
            "status": "waiting" if not self.players["O"] else ("won" if self.winner else "active"),
            "canRestart": self.can_restart(),
            "you": {
                "id": current_player["id"] if current_player else None,
                "symbol": current_symbol,
            },
            "players": {
                symbol: (
                    {
                        "nickname": player["nickname"],
                        "symbol": symbol,
                        "online": player["online_connections"] > 0,
                    }
                    if player
                    else None
                )
                for symbol, player in self.players.items()
            },
        }

    def broadcast(self):
        for listener in list(self.listeners):
            payload = json.dumps(self.to_payload(listener["player_id"]), ensure_ascii=False)
            try:
                listener["queue"].put(payload, timeout=0.1)
            except queue.Full:
                pass

    def touch(self):
        self.updated_at = now_ts()
        self.version += 1


rooms = {}
rooms_lock = threading.Lock()


def get_or_none(code):
    with rooms_lock:
        return rooms.get(code)


def create_room(nickname, show_vanish_hint):
    code = None
    while not code:
        candidate = generate_room_code()
        with rooms_lock:
            if candidate not in rooms:
                rooms[candidate] = GameRoom(candidate, nickname, show_vanish_hint)
                code = candidate
    return rooms[code]


class XORequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format_, *args):
        return

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.write_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/api/health":
            return self.send_json({"ok": True, "rooms": len(rooms), "port": PORT})
        if path.startswith("/api/rooms/") and path.endswith("/stream"):
            return self.handle_stream(path, parsed)
        if path.startswith("/api/rooms/"):
            return self.handle_room_snapshot(path, parsed)
        return self.serve_static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/api/rooms":
            return self.handle_create_room()

        room, suffix = self.resolve_room_action(path)
        if not room:
            return self.send_json({"error": "Комната не найдена."}, HTTPStatus.NOT_FOUND)

        if suffix == "/join":
            return self.handle_join_room(room)
        if suffix == "/move":
            return self.handle_move(room)
        if suffix == "/restart":
            return self.handle_restart(room)

        return self.send_json({"error": "Маршрут не найден."}, HTTPStatus.NOT_FOUND)

    def resolve_room_action(self, path):
        prefix = "/api/rooms/"
        if not path.startswith(prefix):
            return None, None
        tail = path[len(prefix) :]
        parts = [part for part in tail.split("/") if part]
        if not parts:
            return None, None
        code = normalize_code(parts[0])
        room = get_or_none(code)
        suffix = "/" + "/".join(parts[1:]) if len(parts) > 1 else ""
        return room, suffix

    def read_json(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            return {}
        raw_body = self.rfile.read(content_length)
        if not raw_body:
            return {}
        return json.loads(raw_body.decode("utf-8"))

    def send_json(self, payload, status=HTTPStatus.OK):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.write_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def write_cors_headers(self):
        if not CORS_ALLOW_ORIGIN:
            return
        self.send_header("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN)
        self.send_header("Vary", "Origin")

    def serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"

        safe_path = os.path.normpath(path.lstrip("/"))
        file_path = os.path.abspath(os.path.join(PUBLIC_DIR, safe_path))
        if os.path.commonpath([PUBLIC_DIR, file_path]) != PUBLIC_DIR or not os.path.isfile(file_path):
            return self.send_json({"error": "Файл не найден."}, HTTPStatus.NOT_FOUND)

        mime_type, _ = guess_type(file_path)
        with open(file_path, "rb") as file_obj:
            raw = file_obj.read()

        self.send_response(HTTPStatus.OK)
        self.write_cors_headers()
        self.send_header("Content-Type", f"{mime_type or 'application/octet-stream'}; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def handle_create_room(self):
        try:
            payload = self.read_json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.send_json({"error": "Некорректный JSON."}, HTTPStatus.BAD_REQUEST)

        nickname = (payload.get("nickname") or "").strip()
        if len(nickname) < 2:
            return self.send_json({"error": "Ник должен быть не короче 2 символов."}, HTTPStatus.BAD_REQUEST)

        room = create_room(nickname[:24], payload.get("showVanishHint", True))
        snapshot = room.to_payload(room.players["X"]["id"])
        return self.send_json(
            {
                "playerId": room.players["X"]["id"],
                "room": snapshot,
                "shareUrl": self.build_share_url(room.code),
            },
            HTTPStatus.CREATED,
        )

    def handle_room_snapshot(self, path, parsed):
        room, suffix = self.resolve_room_action(path)
        if not room or suffix:
            return self.send_json({"error": "Комната не найдена."}, HTTPStatus.NOT_FOUND)

        player_id = parse_qs(parsed.query).get("playerId", [None])[0]
        return self.send_json(room.to_payload(player_id))

    def handle_join_room(self, room):
        try:
            payload = self.read_json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.send_json({"error": "Некорректный JSON."}, HTTPStatus.BAD_REQUEST)

        nickname = (payload.get("nickname") or "").strip()
        if len(nickname) < 2:
            return self.send_json({"error": "Ник должен быть не короче 2 символов."}, HTTPStatus.BAD_REQUEST)

        with room.lock:
            if room.players["O"]:
                return self.send_json({"error": "Комната уже заполнена."}, HTTPStatus.CONFLICT)

            player_id = uuid.uuid4().hex
            room.players["O"] = {
                "id": player_id,
                "nickname": nickname[:24],
                "symbol": "O",
                "online_connections": 0,
            }
            room.touch()
            snapshot = room.to_payload(player_id)
            room.broadcast()

        return self.send_json(
            {
                "playerId": player_id,
                "room": snapshot,
                "shareUrl": self.build_share_url(room.code),
            }
        )

    def handle_move(self, room):
        try:
            payload = self.read_json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.send_json({"error": "Некорректный JSON."}, HTTPStatus.BAD_REQUEST)

        player_id = payload.get("playerId")
        cell = payload.get("cell")
        if not isinstance(cell, int) or cell < 0 or cell > 8:
            return self.send_json({"error": "Некорректная клетка."}, HTTPStatus.BAD_REQUEST)

        with room.lock:
            symbol = room.player_symbol(player_id)
            if not symbol:
                return self.send_json({"error": "Игрок не найден в комнате."}, HTTPStatus.FORBIDDEN)
            if not room.players["O"]:
                return self.send_json({"error": "Нужен второй игрок."}, HTTPStatus.CONFLICT)
            if room.winner:
                return self.send_json({"error": "Партия уже завершена."}, HTTPStatus.CONFLICT)
            if room.turn != symbol:
                return self.send_json({"error": "Сейчас ход другого игрока."}, HTTPStatus.CONFLICT)
            if room.board[cell] is not None:
                return self.send_json({"error": "Клетка уже занята."}, HTTPStatus.CONFLICT)

            room.board[cell] = symbol
            room.marks[symbol].append(cell)
            if len(room.marks[symbol]) > MAX_MARKS_PER_PLAYER:
                removed = room.marks[symbol].pop(0)
                room.board[removed] = None

            winner, winning_line = check_winner(room.board)
            if winner:
                room.winner = winner
                room.winning_line = winning_line
            else:
                room.turn = "O" if symbol == "X" else "X"

            room.touch()
            snapshot = room.to_payload(player_id)
            room.broadcast()

        return self.send_json({"room": snapshot})

    def handle_restart(self, room):
        try:
            payload = self.read_json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.send_json({"error": "Некорректный JSON."}, HTTPStatus.BAD_REQUEST)

        player_id = payload.get("playerId")
        with room.lock:
            if not room.player_symbol(player_id):
                return self.send_json({"error": "Игрок не найден в комнате."}, HTTPStatus.FORBIDDEN)
            if not room.can_restart():
                return self.send_json(
                    {"error": "Новая партия доступна после победы или до первого хода."},
                    HTTPStatus.CONFLICT,
                )

            room.board = [None] * 9
            room.marks = {"X": [], "O": []}
            room.turn = "X"
            room.winner = None
            room.winning_line = []
            room.touch()
            snapshot = room.to_payload(player_id)
            room.broadcast()

        return self.send_json({"room": snapshot})

    def handle_stream(self, path, parsed):
        room, suffix = self.resolve_room_action(path[: -len("/stream")])
        if not room or suffix:
            return self.send_json({"error": "Комната не найдена."}, HTTPStatus.NOT_FOUND)

        player_id = parse_qs(parsed.query).get("playerId", [None])[0]
        listener = {"queue": queue.Queue(maxsize=8), "player_id": player_id}

        with room.lock:
            room.listeners.append(listener)
            symbol = room.player_symbol(player_id)
            if symbol:
                room.players[symbol]["online_connections"] += 1
                room.touch()
                room.broadcast()
            listener["queue"].put(json.dumps(room.to_payload(player_id), ensure_ascii=False))

        self.send_response(HTTPStatus.OK)
        self.write_cors_headers()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        try:
            while True:
                try:
                    event_payload = listener["queue"].get(timeout=15)
                    self.wfile.write(f"data: {event_payload}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with room.lock:
                if listener in room.listeners:
                    room.listeners.remove(listener)
                symbol = room.player_symbol(player_id)
                if symbol and room.players[symbol]["online_connections"] > 0:
                    room.players[symbol]["online_connections"] -= 1
                    room.touch()
                    room.broadcast()

    def build_share_url(self, room_code):
        configured_base_url = load_runtime_base_url()
        if configured_base_url:
            return f"{configured_base_url}/?room={room_code}"
        forwarded_host = self.headers.get("X-Forwarded-Host")
        host = forwarded_host or self.headers.get("Host", f"localhost:{PORT}")
        proto = self.headers.get("X-Forwarded-Proto", "http")
        return f"{proto}://{host}/?room={room_code}"


def run():
    server = ThreadingHTTPServer((HOST, PORT), XORequestHandler)
    print(f"XO server started on http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
