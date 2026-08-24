#!/bin/sh
# Загрузить локальный файл на сервер (Deploy API /upload, base64).
# Использование:  scripts/upload.sh <local_path> <remote_path>
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/env.sh" || exit 1

[ -z "$2" ] && { echo "usage: scripts/upload.sh <local> <remote>" >&2; exit 1; }

python3 -c "import base64,json,sys;d=open(sys.argv[1],'rb').read();json.dump({'content':base64.b64encode(d).decode(),'path':sys.argv[2]},open('/tmp/_up.json','w'))" "$1" "$2"
curl -sS -m 150 -H "X-Api-Key: $VIBE_APP_KEY" -H 'Content-Type: application/json' \
  -X POST "$GATEWAY/v1/infra/servers/$SERVER_ID/upload" --data-binary @/tmp/_up.json
echo
