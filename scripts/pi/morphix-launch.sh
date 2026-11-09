#!/bin/bash
# Starts Morphix fullscreen on the Pi touchscreen (Wayland/labwc session).
# At boot the user service can start before the desktop is ready: wait for it.
set -euo pipefail
cd "$(dirname "$0")/../.."
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
for _ in $(seq 1 120); do
  [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break
  sleep 1
done
exec ./node_modules/electron/dist/electron . "$@"
