#!/bin/sh
# Выполнить shell-команду на сервере приложения (Deploy API /exec).
# Использование:  scripts/exec.sh "systemctl is-active planner.service"
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/env.sh" || exit 1

[ -z "$1" ] && { echo "usage: scripts/exec.sh \"<command>\"" >&2; exit 1; }

python3 -c "import json,sys;print(json.dumps({'command':sys.argv[1],'timeout':120}))" "$1" > /tmp/_exec.json
curl -sS -m 150 -H "X-Api-Key: $VIBE_APP_KEY" -H 'Content-Type: application/json' \
  -X POST "$GATEWAY/v1/infra/servers/$SERVER_ID/exec" --data-binary @/tmp/_exec.json \
  | python3 -c "import sys,json;d=json.load(sys.stdin);\
data=d.get('data');\
print(data.get('stdout','') if isinstance(data,dict) else d);\
print(('STDERR: '+data['stderr']) if isinstance(data,dict) and data.get('stderr') else '', end='')"
