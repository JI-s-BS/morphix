#!/bin/bash
# Installs dependencies (only when package-lock.json changes), runs the tests and builds Morphix.
set -euo pipefail
cd "$(dirname "$0")/../.."
bash scripts/pi/ensure-node.sh
export PATH="$HOME/.local/share/morphix-node/current/bin:$PATH"
LOCK_SUM="$(sha256sum package-lock.json | awk '{print $1}')"
if [ ! -f node_modules/.morphix-lock.sha ] || [ "$(cat node_modules/.morphix-lock.sha)" != "$LOCK_SUM" ]; then
  echo "Installing dependencies (first run takes a few minutes)"
  npm ci --no-audit --no-fund
  node node_modules/electron/install.js
  echo "$LOCK_SUM" > node_modules/.morphix-lock.sha
fi
npm test --silent
npm run build --silent
echo "Morphix build ok"
