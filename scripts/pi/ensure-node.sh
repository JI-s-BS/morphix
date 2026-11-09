#!/bin/bash
# Installs the official Node.js 22 LTS build into ~/.local/share/morphix-node
# (no sudo), verifying the download against nodejs.org's SHA-256 list.
set -euo pipefail
NODE_ROOT="$HOME/.local/share/morphix-node"
if [ -x "$NODE_ROOT/current/bin/node" ]; then exit 0; fi
case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "unsupported architecture $(uname -m)"; exit 1 ;;
esac
BASE="https://nodejs.org/dist/latest-v22.x"
SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")"
LINE="$(printf '%s\n' "$SUMS" | grep -E "  node-v[0-9.]+-linux-$ARCH\.tar\.xz$")"
FILE="$(printf '%s' "$LINE" | awk '{print $2}')"
SUM="$(printf '%s' "$LINE" | awk '{print $1}')"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading $FILE"
curl -fsSL -o "$TMP/$FILE" "$BASE/$FILE"
echo "$SUM  $TMP/$FILE" | sha256sum -c -
mkdir -p "$NODE_ROOT"
tar -xJf "$TMP/$FILE" -C "$NODE_ROOT"
ln -sfn "$NODE_ROOT/${FILE%.tar.xz}" "$NODE_ROOT/current"
"$NODE_ROOT/current/bin/node" -v
