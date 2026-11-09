#!/bin/bash
# Run by Pi Manager (as jd) after every push to main.
set -euo pipefail
cd "$(dirname "$0")"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

echo "== QD330 dashboard"
python3 -m py_compile services/qd330-dashboard/printer_control/*.py
bash scripts/pi/install-user-services.sh

echo "== Fonts"
bash scripts/pi/ensure-fonts.sh || echo "WARNING: could not install the emoji font"

echo "== Speech (spoken print warnings fallback)"
bash scripts/pi/ensure-tts.sh || echo "WARNING: could not install espeak-ng; print warnings will only use Gemini's voice"

echo "== Guardian (Python/OpenCV)"
bash scripts/pi/ensure-vision.sh || echo "WARNING: guardian Python setup failed; monitoring will report the worker as down"

echo "== Morphix"
bash scripts/pi/build-morphix.sh
# Don't restart in the middle of a Claude/Meshy design, a slice or an upload: Morphix keeps
# ~/Morphix/run/busy fresh while it works (stale after 30 s = the app isn't running). Wait up
# to 30 minutes, then restart anyway. A print on the printer carries on through a restart.
BUSY="$HOME/Morphix/run/busy"
for _ in $(seq 1 180); do
  [ -f "$BUSY" ] && [ $(( $(date +%s) - $(stat -c %Y "$BUSY" 2>/dev/null || echo 0) )) -lt 30 ] || break
  echo "Morphix is busy ($(head -c 200 "$BUSY" 2>/dev/null)); waiting to restart"
  sleep 10
done
systemctl --user restart morphix.service
sleep 8
if systemctl --user is-active --quiet morphix.service; then
  echo "Morphix restarted with the new build"
else
  echo "WARNING: Morphix did not stay running; see: journalctl --user -u morphix -n 50"
  exit 1
fi
