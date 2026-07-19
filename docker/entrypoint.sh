#!/bin/sh
set -eu

EXPECTED_BUILD_ID="portal-v1-public"

if [ "${PORTAL_BUILD_ID:-}" != "$EXPECTED_BUILD_ID" ]; then
  echo "Refusing to start: PORTAL_BUILD_ID must be $EXPECTED_BUILD_ID." >&2
  exit 1
fi

if [ ! -f /app/PUBLIC_BUILD_NOTICE.txt ]; then
  echo "Refusing to start: public-build notice is missing from the image." >&2
  exit 1
fi

echo "[portal-v1-public] starting provider-neutral public build on container port ${PORT:-3000}"
exec node /app/server.js
