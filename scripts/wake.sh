#!/bin/sh
# Дождаться, пока сервер проснётся (RUNNING/CONNECTED); при необходимости будит.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/env.sh" || exit 1

i=0
while [ "$i" -lt 40 ]; do
  i=$((i + 1))
  S=$(curl -sS -m 20 -H "X-Api-Key: $VIBE_APP_KEY" "$GATEWAY/v1/infra/servers/$SERVER_ID" \
      | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(d['status'],d['blackholeStatus'])")
  echo "[$i] $S"
  case "$S" in
    "running CONNECTED") exit 0 ;;
    sleeping*|provisioning*)
      curl -sS -m 20 -H "X-Api-Key: $VIBE_APP_KEY" -H 'Content-Type: application/json' \
        -X POST "$GATEWAY/v1/infra/servers/$SERVER_ID/wake" -d '{}' >/dev/null 2>&1 ;;
  esac
  sleep 6
done
echo "server not ready after wait" >&2
exit 1
