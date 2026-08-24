#!/bin/sh
# Несекретные параметры окружения планировщика. Подключается остальными
# скриптами: . scripts/env.sh
#
# Секрет (ключ приложения vibe_app_*) НЕ хранится здесь — берётся из
# переменной окружения VIBE_APP_KEY.

export SERVER_ID="108d2440-8546-4c0a-a0c8-d6c6f1ed07c7"
export APP_URL="https://app-13995b2c41ce.vibecode.bitrix24.tech"
export GATEWAY="https://vibecode.bitrix24.tech"
export PORTAL="avrika.bitrix24.ru"

if [ -z "$VIBE_APP_KEY" ]; then
  echo "ERROR: не задана переменная VIBE_APP_KEY (ключ приложения vibe_app_*)." >&2
  echo "Задайте её перед запуском:  export VIBE_APP_KEY='vibe_app_local_...'" >&2
  return 1 2>/dev/null || exit 1
fi
