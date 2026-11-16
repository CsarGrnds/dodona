#!/usr/bin/env bash
# Captures the README screenshots (docs/screenshots/*.png) from a running DEMO server.
#
#   1. npm run demo:portfolio                       # fictional portfolio at live prices
#   2. Start Dodona in demo mode (the "dodona-demo" launch config, or):
#        DODONA_PORTFOLIO=docs/demo/portfolio.json IBKR_GATEWAY_URL=https://localhost:5999 npm run dev
#      The gateway URL points at a closed port, so no real IBKR account data can load.
#   3. npm run screenshots
#
# The README is public: never capture against your real portfolio or a logged-in gateway.
set -euo pipefail

BASE="${DODONA_URL:-http://localhost:3000}"
OUT="docs/screenshots"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
mkdir -p "$OUT"

# Refuse to run against the real account: the server must be serving the demo portfolio.
if ! curl -s "$BASE/api/portfolio" | grep -q '"demo":true'; then
  echo "The server at $BASE isn't serving docs/demo/portfolio.json. Start it in demo mode first (see the top of this script)." >&2
  exit 1
fi

shot() { # name path height
  local name="$1" path="$2" height="${3:-1100}"
  local prof
  prof="$(mktemp -d)"
  # New York time, so the market bar shows ET and not this machine's time zone.
  TZ=America/New_York "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
    --user-data-dir="$prof" --force-device-scale-factor=2 --window-size="1280,$height" \
    --virtual-time-budget=25000 --screenshot="$OUT/$name.png" "$BASE$path" >/dev/null 2>&1
  rm -rf "$prof"
  echo "  $OUT/$name.png"
}

echo "Capturing from $BASE"
shot main / 1250
shot ticker "/ticker/AAPL?strategy=swing" 1500
shot today /today 1400
shot setups /setups 1100
shot portfolio /portfolio 1000
shot status /status 1300
