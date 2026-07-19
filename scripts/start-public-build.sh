#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
MARKER_FILE="$PROJECT_DIR/PUBLIC_BUILD_MARKER.txt"
EXPECTED_ID="portal-v1-public"

if [[ ! -f "$MARKER_FILE" ]] || ! grep -qx "PORTAL_BUILD_ID=$EXPECTED_ID" "$MARKER_FILE"; then
  echo "Refusing to start: public-build marker is missing or invalid." >&2
  exit 1
fi

if [[ "${PORTAL_BUILD_ID:-}" != "$EXPECTED_ID" ]]; then
  echo "Refusing to start: set PORTAL_BUILD_ID=$EXPECTED_ID in this installation's .env." >&2
  exit 1
fi

if [[ "${PORT:-3100}" == "3000" ]]; then
  echo "Refusing to start the public build on the default private-portal port 3000; use a separate port such as 3100." >&2
  exit 1
fi

cd "$PROJECT_DIR"
export PORT="${PORT:-3100}"
echo "[portal-v1-public] starting provider-neutral public build from $PROJECT_DIR on port $PORT"
exec node server.js
