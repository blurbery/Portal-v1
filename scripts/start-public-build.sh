#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
MARKER_FILE="$PROJECT_DIR/PUBLIC_BUILD_MARKER.txt"
ENV_FILE="$PROJECT_DIR/.env"
EXPECTED_ID="portal-v1-public"

if [[ ! -f "$MARKER_FILE" ]] || ! grep -qx "PORTAL_BUILD_ID=$EXPECTED_ID" "$MARKER_FILE"; then
  echo "Refusing to start: public-build marker is missing or invalid." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Refusing to start: .env is missing. Copy .env.example and configure this installation." >&2
  exit 1
fi

CONFIGURED_BUILD_ID="$(sed -n 's/^PORTAL_BUILD_ID=//p' "$ENV_FILE" | head -n 1)"
if [[ "$CONFIGURED_BUILD_ID" != "$EXPECTED_ID" ]]; then
  echo "Refusing to start: .env must contain PORTAL_BUILD_ID=$EXPECTED_ID." >&2
  exit 1
fi

CONFIGURED_PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | head -n 1)"
SELECTED_PORT="${PORT:-${CONFIGURED_PORT:-3100}}"
if [[ "$SELECTED_PORT" == "3000" ]]; then
  echo "Refusing to start the public build on the default private-portal port 3000; use a separate port such as 3100." >&2
  exit 1
fi

cd "$PROJECT_DIR"
export PORTAL_BUILD_ID="$EXPECTED_ID"
export PORT="$SELECTED_PORT"
echo "[portal-v1-public] starting provider-neutral public build from $PROJECT_DIR on port $PORT"
exec node server.js
