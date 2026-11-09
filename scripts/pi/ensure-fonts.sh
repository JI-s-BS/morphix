#!/bin/bash
# Colour emoji for the kid-friendly UI. No sudo: download Debian's own
# fonts-noto-color-emoji package and install the font for this user only.
set -euo pipefail
if fc-list 2>/dev/null | grep -qi "Noto Color Emoji"; then exit 0; fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
apt-get download fonts-noto-color-emoji >/dev/null
dpkg -x fonts-noto-color-emoji_*.deb x
mkdir -p "$HOME/.local/share/fonts"
find x -name 'NotoColorEmoji*.ttf' -exec cp {} "$HOME/.local/share/fonts/" \;
fc-cache -f "$HOME/.local/share/fonts" >/dev/null
fc-list | grep -qi "Noto Color Emoji" && echo "emoji font installed"
