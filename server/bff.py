#!/usr/bin/env python3
"""BFF (backend-for-frontend) для планировщика на хостинге vibecode.

Зачем нужен: встроенные приложения vibecode работают по BFF-схеме. Шлюз
авторизует пользователя через /v1/bitrix-handler и на каждый запрос к серверу
приложения подставляет заголовок ``X-Vibe-Authorization: Bearer vibe_session_*``
(в браузер токен не попадает). Поэтому статический фронтенд не может сам ходить
в REST — нужен этот тонкий прокси.

Что делает сервер:
  * отдаёт статику из PUBLIC_DIR (SPA: index.html);
  * /api/v1/<...>     -> проксирует на https://vibecode.bitrix24.tech/v1/<...>,
    добавляя X-Api-Key (ключ приложения из env VIBE_APP_KEY) и Authorization из
    сессии шлюза. Клиентский Authorization для /v1 не используется;
  * /api/placements   -> ОБЩЕЕ для всех пользователей портала хранилище
    «размещений» задач на сетке (планирование). Лежит в файле на сервере
    приложения, поэтому видно всем, кто открывает приложение, а не только
    автору (в отличие от localStorage в браузере);
  * /api/whoami       -> диагностика: видна ли сессия от шлюза.

Только stdlib — на сервере есть лишь python3.
"""

import http.server
import json
import os
import threading
import urllib.error
import urllib.request
import uuid

PUBLIC_DIR = "/opt/app/public"
UPSTREAM = "https://vibecode.bitrix24.tech"
PORT = 3000
SESSION_HEADER = "X-Vibe-Authorization"
APP_KEY = os.environ.get("VIBE_APP_KEY", "")

# Общее (для всех пользователей портала) хранилище размещений задач.
DATA_DIR = "/opt/app/data"
PLACEMENTS_FILE = os.path.join(DATA_DIR, "placements.json")
_lock = threading.Lock()

# Домен портала (для ссылок на задачи). Узнаём через /v1/me по ключу
# приложения и кэшируем.
_portal_cache = {"v": None}


def _portal_domain():
    if _portal_cache["v"] or not APP_KEY:
        return _portal_cache["v"]
    try:
        req = urllib.request.Request(UPSTREAM + "/v1/me", method="GET")
        req.add_header("X-Api-Key", APP_KEY)
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read().decode("utf-8"))
        _portal_cache["v"] = (d.get("data") or {}).get("portal")
    except Exception:
        pass
    return _portal_cache["v"]


def _read_placements():
    try:
        with open(PLACEMENTS_FILE, encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []


def _write_placements(arr):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = PLACEMENTS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(arr, f, ensure_ascii=False)
    os.replace(tmp, PLACEMENTS_FILE)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._handle_api("GET")
        return super().do_GET()

    def do_POST(self):
        return self._handle_api("POST") if self.path.startswith("/api/") else self.send_error(404)

    def do_PATCH(self):
        return self._handle_api("PATCH") if self.path.startswith("/api/") else self.send_error(404)

    def do_DELETE(self):
        return self._handle_api("DELETE") if self.path.startswith("/api/") else self.send_error(404)

    # --- helpers -----------------------------------------------------------

    def _session(self):
        return self.headers.get(SESSION_HEADER) or self.headers.get("Authorization")

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if not length:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return None

    def _send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- routing -----------------------------------------------------------

    def _handle_api(self, method):
        session = self._session()
        path = self.path.split("?", 1)[0]

        if path == "/api/whoami":
            return self._send_json(200, {"hasSession": bool(session)})

        if path == "/api/portal":
            return self._send_json(200, {"success": True, "data": {"portal": _portal_domain()}})

        if path == "/api/placements" or path.startswith("/api/placements/"):
            return self._handle_placements(method, path, session)

        if not path.startswith("/api/v1/"):
            return self._send_json(404, {"error": "NOT_FOUND"})

        if not session:
            return self._send_json(401, {
                "error": "NO_SESSION",
                "message": "Нет сессии шлюза. Откройте приложение внутри портала Битрикс24.",
            })
        return self._proxy_v1(method, session)

    # Общее хранилище размещений (планирование). Доступно только из портала
    # (через шлюз сессия всегда есть), пишется атомарно под локом.
    def _handle_placements(self, method, path, session):
        if not session:
            return self._send_json(401, {"error": "NO_SESSION"})

        if path == "/api/placements":
            if method == "GET":
                with _lock:
                    return self._send_json(200, {"success": True, "data": _read_placements()})
            if method == "POST":
                body = self._read_json() or {}
                item = {
                    "id": "pl_" + uuid.uuid4().hex[:12],
                    "taskId": str(body.get("taskId", "")),
                    "title": body.get("title") or "Задача",
                    "userId": str(body.get("userId", "")),
                    "start": body.get("start"),
                    "end": body.get("end"),
                }
                with _lock:
                    arr = _read_placements()
                    arr.append(item)
                    _write_placements(arr)
                return self._send_json(200, {"success": True, "data": item})
            return self._send_json(405, {"error": "METHOD_NOT_ALLOWED"})

        pid = path[len("/api/placements/"):]
        if method == "PATCH":
            body = self._read_json() or {}
            with _lock:
                arr = _read_placements()
                for p in arr:
                    if p.get("id") == pid:
                        if body.get("start"):
                            p["start"] = body["start"]
                        if body.get("end"):
                            p["end"] = body["end"]
                _write_placements(arr)
            return self._send_json(200, {"success": True})
        if method == "DELETE":
            with _lock:
                _write_placements([p for p in _read_placements() if p.get("id") != pid])
            return self._send_json(200, {"success": True})
        return self._send_json(405, {"error": "METHOD_NOT_ALLOWED"})

    # Прокси на REST vibecode с серверным ключом приложения + сессией шлюза.
    def _proxy_v1(self, method, session):
        url = UPSTREAM + self.path[len("/api"):]
        length = int(self.headers.get("Content-Length", 0) or 0)
        data = self.rfile.read(length) if length else None

        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", session)
        if APP_KEY:
            req.add_header("X-Api-Key", APP_KEY)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload, status, ctype = resp.read(), resp.status, resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            payload, status, ctype = e.read(), e.code, e.headers.get("Content-Type", "application/json")
        except Exception as e:
            return self._send_json(502, {"error": "UPSTREAM_ERROR", "message": str(e)})

        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    httpd.serve_forever()
