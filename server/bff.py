#!/usr/bin/env python3
"""BFF (backend-for-frontend) для планировщика на хостинге vibecode.

Зачем нужен: встроенные приложения vibecode работают по BFF-схеме. Шлюз
авторизует пользователя через /v1/bitrix-handler и на каждый запрос к серверу
приложения подставляет заголовок ``X-Vibe-Authorization: Bearer vibe_session_*``
(в браузер токен не попадает). Поэтому статический фронтенд не может сам ходить
в REST — нужен этот тонкий прокси.

Что делает сервер:
  * отдаёт статику из PUBLIC_DIR (SPA: index.html);
  * /api/v1/<...>  -> проксирует на https://vibecode.bitrix24.tech/v1/<...>,
    подставляя СЕРВЕРНЫЙ заголовок сессии (клиентский Authorization не
    используется — это защита от утечки токена через XSS);
  * /api/whoami    -> диагностика: видна ли сессия от шлюза.

Только stdlib — на сервере есть лишь python3.
"""

import http.server
import json
import time
import urllib.error
import urllib.request

PUBLIC_DIR = "/opt/app/public"
UPSTREAM = "https://vibecode.bitrix24.tech"
PORT = 3000
# Заголовок, который шлюз vibecode подставляет на пути «шлюз -> сервер».
SESSION_HEADER = "X-Vibe-Authorization"
# Временный диагностический лог (включается переменной BFF_DEBUG=1).
import os
DEBUG = os.environ.get("BFF_DEBUG") == "1"
LOG_PATH = "/opt/app/bff.log"


def _redact(v):
    if not v:
        return None
    return v[:18] + "…(len=%d)" % len(v)


def _dlog(line):
    if not DEBUG:
        return
    try:
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    # Статику отдаём без кэша, чтобы новые сборки подхватывались сразу.
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

    # --- API ---------------------------------------------------------------

    def _session(self):
        # В реальном placement-потоке шлюз подставляет X-Vibe-Authorization
        # (браузер токен не видит). В режиме api-bearer (smoke-тесты) шлюз
        # пробрасывает исходный Authorization. Берём первый доступный.
        return self.headers.get(SESSION_HEADER) or self.headers.get("Authorization")

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_api(self, method):
        session = self._session()

        if self.path == "/api/whoami":
            return self._send_json(200, {"hasSession": bool(session)})

        if not self.path.startswith("/api/v1/"):
            return self._send_json(404, {"error": "NOT_FOUND"})

        if not session:
            return self._send_json(401, {
                "error": "NO_SESSION",
                "message": "Нет сессии шлюза. Откройте приложение внутри портала Битрикс24.",
            })

        # /api/v1/<rest>?<query>  ->  https://vibecode.bitrix24.tech/v1/<rest>?<query>
        url = UPSTREAM + self.path[len("/api"):]
        length = int(self.headers.get("Content-Length", 0) or 0)
        data = self.rfile.read(length) if length else None

        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", session)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload, status, ctype = resp.read(), resp.status, resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            payload, status, ctype = e.read(), e.code, e.headers.get("Content-Type", "application/json")
        except Exception as e:  # сеть/таймаут
            _dlog("%s %s -> EXC %s" % (time.strftime("%H:%M:%S"), self.path, e))
            return self._send_json(502, {"error": "UPSTREAM_ERROR", "message": str(e)})

        if DEBUG:
            hdr_dump = {k: (_redact(self.headers.get(k)) if any(s in k.lower() for s in ("auth", "vibe", "token", "session", "cookie")) else self.headers.get(k)) for k in self.headers.keys()}
            _dlog("%s %s %s\n  used_session=%s\n  req_headers=%s\n  -> upstream %s status=%s body=%s" % (
                time.strftime("%H:%M:%S"), method, self.path, _redact(session),
                json.dumps(hdr_dump, ensure_ascii=False),
                url, status, payload[:300].decode("utf-8", "replace")))

        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass  # тихий лог


if __name__ == "__main__":
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    httpd.serve_forever()
