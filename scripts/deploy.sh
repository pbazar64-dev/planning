#!/bin/sh
# Полный деплой приложения на сервер:
#   1) сборка single-file dist/index.html
#   2) загрузка index.html и bff.py
#   3) рестарт сервиса и проверка контрольной суммы
#
# Требуется: node, python3, curl и переменная VIBE_APP_KEY.
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/env.sh" || exit 1
ROOT=$(CDPATH= cd -- "$DIR/.." && pwd)

echo "0) Ждём готовности сервера..."
sh "$DIR/wake.sh"

echo "1) Сборка dist/index.html..."
node "$ROOT/tools/build-singlefile.mjs"

echo "2) Загрузка dist/index.html -> /opt/app/public/index.html"
sh "$DIR/upload.sh" "$ROOT/dist/index.html" /opt/app/public/index.html

echo "3) Загрузка server/bff.py -> /opt/app/bff.py"
sh "$DIR/upload.sh" "$ROOT/server/bff.py" /opt/app/bff.py

echo "4) Рестарт сервиса и проверка..."
sh "$DIR/exec.sh" "systemctl restart planner.service && sleep 1 && systemctl is-active planner.service && curl -s -o /dev/null -w 'http=%{http_code}\n' http://127.0.0.1:3000/ && sha256sum /opt/app/public/index.html"

echo "local dist sha: $(sha256sum "$ROOT/dist/index.html" | cut -d' ' -f1)"
echo "Готово. Приложение: $APP_URL"
