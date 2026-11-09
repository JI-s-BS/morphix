#!/bin/bash
# Installs Morphix and the QD330 dashboard as systemd *user* services for jd.
# No sudo needed: jd's user manager runs at boot (lingering is enabled).
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd ../.. && pwd)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR" "$HOME/.local/bin" "$HOME/.local/share/applications"
for u in systemd/*.service; do
  sed "s|@REPO@|$REPO|g" "$u" > "$UNIT_DIR/$(basename "$u")"
done
cat > "$HOME/.local/bin/qd330ctl" <<SH
#!/bin/bash
cd "$REPO/services/qd330-dashboard" && exec python3 -m printer_control.cli "\$@"
SH
chmod 755 "$HOME/.local/bin/qd330ctl"
cat > "$HOME/.local/share/applications/morphix.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Morphix
Comment=AI-powered 3D printing
Exec=systemctl --user start morphix.service
Icon=applications-graphics
Categories=Graphics;
DESK
systemctl --user daemon-reload
# Both run at boot: Morphix hosts the touchscreen app and the web portal.
systemctl --user enable --now qd330-web.service >/dev/null
systemctl --user restart qd330-web.service
systemctl --user enable morphix.service >/dev/null
