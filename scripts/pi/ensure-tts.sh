#!/bin/bash
# Local text-to-speech for spoken print warnings when Gemini is unreachable.
# No sudo: download Debian's espeak-ng packages and unpack them for this user only.
# Morphix runs ~/.local/share/morphix-tts/run-espeak (see apps/desktop/electron/tts.ts).
set -euo pipefail
DEST="$HOME/.local/share/morphix-tts"
RUN="$DEST/run-espeak"
# A real synthesis check (--version succeeds even when the voice data can't be found).
speaks() { [ "$("$1" --stdout -v en-us ok 2>/dev/null | head -c 4)" = "RIFF" ]; }
if [ -x "$RUN" ] && speaks "$RUN"; then exit 0; fi
if command -v espeak-ng >/dev/null 2>&1; then
  mkdir -p "$DEST"
  printf '#!/bin/sh\nexec espeak-ng "$@"\n' > "$RUN"
  chmod +x "$RUN"
  echo "using system espeak-ng"
  exit 0
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
apt-get download espeak-ng libespeak-ng1 espeak-ng-data libpcaudio0 libsonic0 >/dev/null
rm -rf "$DEST.new"
mkdir -p "$DEST.new"
for d in ./*.deb; do dpkg -x "$d" "$DEST.new"; done
BIN="$(find "$DEST.new" -path '*/bin/espeak-ng' -type f | head -1)"
# The real data dir holds phontab (the package also ships a doc dir named espeak-ng-data).
PHONTAB="$(find "$DEST.new" -name phontab -path '*espeak-ng-data*' | head -1)"
DATA="${PHONTAB:+$(dirname "$PHONTAB")}"
LIBS="$(dirname "$(find "$DEST.new" -name 'libespeak-ng.so*' | head -1)")"
[ -n "$BIN" ] && [ -n "$DATA" ] && [ -n "$LIBS" ] || { echo "espeak-ng packages did not unpack as expected" >&2; exit 1; }
rm -rf "$DEST"
mv "$DEST.new" "$DEST"
BIN="${BIN/$DEST.new/$DEST}"; DATA="${DATA/$DEST.new/$DEST}"; LIBS="${LIBS/$DEST.new/$DEST}"
cat > "$RUN" <<EOF
#!/bin/sh
export LD_LIBRARY_PATH="$LIBS\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "$BIN" --path="$(dirname "$DATA")" "\$@"
EOF
chmod +x "$RUN"
if speaks "$RUN"; then echo "espeak-ng installed for local speech"; else echo "espeak-ng installed but cannot speak" >&2; exit 1; fi
