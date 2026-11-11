#!/usr/bin/env bash
# Morphix installer for Linux (Debian/Ubuntu/Raspberry Pi OS, Fedora, Arch; x86_64, aarch64, armv7l).
#
#   curl -fsSL https://raw.githubusercontent.com/JI-s-BS/morphix/main/scripts/install/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --user --with-prusaslicer
#   bash install.sh --dry-run          # show what it would do, change nothing
#   bash install.sh --uninstall [--purge]
#
# Safe to pipe into bash: everything is a function and `main` runs on the last line, so a
# download cut short runs nothing. Safe to re-run: every step checks before it changes anything.
# See docs/INSTALL.md.
set -euo pipefail

INSTALLER_VERSION="1.0.0"
DEFAULT_REPO_URL="https://github.com/JI-s-BS/morphix.git"
NODE_LINE="${MORPHIX_NODE_LINE:-22}"   # Node.js LTS line (official binaries from nodejs.org)
MIN_RAM_MB=900
LOW_RAM_MB=1900
MIN_DISK_MB=2048

# ------------------------------------------------------------------ output ---
say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Runs a command, or only prints it with --dry-run.
run() {
  if [[ "$DRY_RUN" == 1 ]]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi
}

# Runs a command as root (sudo when needed).
as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then run "$@"
  elif [[ "$DRY_RUN" == 1 ]]; then printf '[dry-run] sudo %s\n' "$*"
  else sudo -- "$@"; fi
}

# Writes stdin to a file with a mode (and owner), through root when needed.
write_file() {
  local path="$1" mode="$2" owner="${3:-}" root="${4:-0}" tmp
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '[dry-run] write %s (mode %s%s)\n' "$path" "$mode" "${owner:+, owner $owner}"
    cat >/dev/null
    return 0
  fi
  tmp="$(mktemp)"
  cat >"$tmp"
  if [[ "$root" == 1 && "$(id -u)" -ne 0 ]]; then
    sudo install -D -m "$mode" ${owner:+-o "${owner%%:*}" -g "${owner##*:}"} "$tmp" "$path"
  else
    install -D -m "$mode" ${owner:+-o "${owner%%:*}" -g "${owner##*:}"} "$tmp" "$path"
  fi
  rm -f "$tmp"
}

# True when there is a terminal to ask (not the case under cron, CI or a piped ssh command).
have_tty() { { true </dev/tty; } 2>/dev/null; }

confirm() {
  local question="$1" answer=""
  [[ "$ASSUME_YES" == 1 ]] && return 0
  [[ "$DRY_RUN" == 1 ]] && { say "[dry-run] would ask: $question"; return 0; }
  have_tty || die "no terminal to ask \"$question\"; add --yes to answer yes"
  printf '%s [y/N] ' "$question" >/dev/tty
  read -r answer </dev/tty || true
  [[ "$answer" == [yY]* ]]
}

usage() {
  cat <<'EOF'
Morphix installer

  install.sh [options]

  --user               install for this user only (no root; ~/.local/share/morphix-app)
  --system             install as a system service for all users (default; needs sudo)
  --channel stable|main
                       stable = newest release tag (default), main = latest code
  --skip-tests         don't run the test suite before the first start
  --with-prusaslicer   also install PrusaSlicer from the distro (hints for Orca/Bambu Studio)
  --with-extras        espeak-ng (spoken print warnings offline) and Python OpenCV (print guardian)
  --kiosk              open Morphix full screen on this machine's display at login
  --kiosk-user NAME    desktop account for the kiosk (default: the user who ran sudo)
  --auto-update        turn on nightly updates (never during a print; off by default)
  --port N             web port (default 8080)
  --repo URL|PATH      git repository to install from (default: GitHub)
  --force              continue on low RAM; rebuild even if up to date
  --dry-run            print what would be done; change nothing
  --uninstall          remove Morphix (keeps your data unless --purge)
  --purge              with --uninstall: also delete the data dir and the morphix user
  --yes                answer yes to questions
  -h, --help
EOF
}

# ---------------------------------------------------------------- parsing ---
parse_args() {
  SCOPE=system CHANNEL_ARG="" SKIP_TESTS=0 WITH_PRUSA=0 WITH_EXTRAS=0 KIOSK=0 KIOSK_USER="" AUTO_UPDATE=0
  PORT_ARG="" REPO_URL="$DEFAULT_REPO_URL" FORCE=0 DRY_RUN=0 UNINSTALL=0 PURGE=0 ASSUME_YES=0
  while (($#)); do
    case "$1" in
      --user) SCOPE=user ;;
      --system) SCOPE=system ;;
      --channel)
        [[ $# -ge 2 ]] || { warn "--channel needs stable or main"; return 2; }
        CHANNEL_ARG="$2"; shift ;;
      --channel=*) CHANNEL_ARG="${1#--channel=}" ;;
      --skip-tests) SKIP_TESTS=1 ;;
      --with-prusaslicer) WITH_PRUSA=1 ;;
      --with-extras) WITH_EXTRAS=1 ;;
      --kiosk) KIOSK=1 ;;
      --kiosk-user)
        [[ $# -ge 2 ]] || { warn "--kiosk-user needs a user name"; return 2; }
        KIOSK_USER="$2"; KIOSK=1; shift ;;
      --auto-update) AUTO_UPDATE=1 ;;
      --port)
        [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] && (($2 >= 1 && $2 <= 65535)) || { warn "--port needs a number 1-65535"; return 2; }
        PORT_ARG="$2"; shift ;;
      --repo)
        [[ $# -ge 2 ]] || { warn "--repo needs a URL or path"; return 2; }
        REPO_URL="$2"; shift ;;
      --force) FORCE=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --uninstall) UNINSTALL=1 ;;
      --purge) PURGE=1 ;;
      --yes | -y) ASSUME_YES=1 ;;
      -h | --help) usage; exit 0 ;;
      *) warn "unknown option: $1 (see --help)"; return 2 ;;
    esac
    shift
  done
  if [[ -n "$CHANNEL_ARG" && "$CHANNEL_ARG" != stable && "$CHANNEL_ARG" != main ]]; then
    warn "--channel must be stable or main"; return 2
  fi
  if [[ "$PURGE" == 1 && "$UNINSTALL" != 1 ]]; then warn "--purge only goes with --uninstall"; return 2; fi
  return 0
}

# --------------------------------------------------------------- detection ---
# Sets OS_ID, OS_NAME, PKG (apt|dnf|pacman). Returns 3 for an unsupported distro (after
# printing the manual steps). MORPHIX_OS_RELEASE overrides /etc/os-release (tests).
detect_os() {
  local file="${MORPHIX_OS_RELEASE:-/etc/os-release}" ID="" ID_LIKE="" PRETTY_NAME="" key value
  [[ -r "$file" ]] || { manual_steps "unknown (no $file)"; return 3; }
  while IFS='=' read -r key value; do
    value="${value%\"}"; value="${value#\"}"
    case "$key" in ID) ID="$value" ;; ID_LIKE) ID_LIKE="$value" ;; PRETTY_NAME) PRETTY_NAME="$value" ;; esac
  done <"$file"
  # shellcheck disable=SC2034 # OS_ID is part of detect_os's result (read by tests and for messages)
  OS_ID="$ID" OS_NAME="${PRETTY_NAME:-$ID}" PKG=""
  case " $ID $ID_LIKE " in
    *" debian "* | *" ubuntu "* | *" raspbian "*) PKG=apt ;;
    *" fedora "*) PKG=dnf ;;
    *" arch "*) PKG=pacman ;;
  esac
  if [[ -z "$PKG" ]]; then manual_steps "$OS_NAME"; return 3; fi
  case "$ID" in
    debian | ubuntu | raspbian | fedora | arch) ;;
    *) warn "$OS_NAME is not tested; treating it like ${ID_LIKE%% *} ($PKG)" ;;
  esac
  return 0
}

manual_steps() {
  cat >&2 <<EOF
Morphix's installer supports Debian, Ubuntu, Raspberry Pi OS (apt), Fedora (dnf) and Arch (pacman).
This system is: $1

You can still install it by hand (docs/INSTALL.md, "Other Linux"):
  1. Install git, curl, xz, tar, make, a C++ compiler, python3 and Node.js $NODE_LINE or newer.
  2. git clone $DEFAULT_REPO_URL morphix && cd morphix
  3. ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci && npm run build && npm run build:server
  4. MORPHIX_DATA_DIR=\$HOME/.local/share/morphix node apps/server/dist/server.cjs
Or use Docker: docker compose up -d (see docker-compose.yml).
EOF
}

# Sets ARCH (uname -m) and NODE_ARCH (nodejs.org name). Returns 4 when refused.
detect_arch() {
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64 | amd64) NODE_ARCH=x64 ;;
    aarch64 | arm64) NODE_ARCH=arm64 ;;
    armv7l | armv8l)
      NODE_ARCH=armv7l
      warn "32-bit ARM works but is slow to build; a 64-bit OS is recommended on a Raspberry Pi 3/4/5" ;;
    armv6l)
      say "Refusing to install: this is an ARMv6 board (Raspberry Pi Zero / Zero W / Pi 1)." >&2
      say "Node.js $NODE_LINE has no official build for ARMv6 and the board is too slow and small (512 MB) to build or run Morphix." >&2
      say "Use a Raspberry Pi Zero 2 W, 3, 4 or 5 (64-bit Raspberry Pi OS), or any x86_64 PC." >&2
      return 4 ;;
    *)
      say "Refusing to install: unsupported CPU architecture $ARCH (supported: x86_64, aarch64, armv7l)." >&2
      say "Docker (docker-compose.yml) may still work if your platform has a node:22 image." >&2
      return 4 ;;
  esac
  return 0
}

# RAM from /proc/meminfo (MORPHIX_MEMINFO overrides for tests). Returns 5 when too little.
check_ram() {
  local kb mb
  kb="$(awk '/^MemTotal:/ {print $2}' "${MORPHIX_MEMINFO:-/proc/meminfo}" 2>/dev/null || echo 0)"
  mb=$((${kb:-0} / 1024))
  RAM_MB="$mb"
  if ((mb < MIN_RAM_MB)); then
    if [[ "$FORCE" == 1 ]]; then warn "only $mb MB RAM; continuing because of --force (add swap or the build may fail)"; return 0; fi
    say "Refusing to install: building Morphix needs about 1 GB of RAM and this machine has $mb MB." >&2
    say "Add swap (e.g. sudo dphys-swapfile on Raspberry Pi OS) and re-run with --force, or build the Docker image on another machine." >&2
    return 5
  fi
  ((mb < LOW_RAM_MB)) && warn "$mb MB RAM: the build will be slow; 1-2 GB of swap helps"
  return 0
}

# Free space where the app will live (first existing parent of $1). Returns 6 when too little.
check_disk() {
  local dir="$1" mb
  while [[ ! -d "$dir" ]]; do dir="$(dirname "$dir")"; done
  mb="$(df -Pm "$dir" 2>/dev/null | awk 'NR==2 {print $4}')"
  DISK_MB="${mb:-0}"
  if ((DISK_MB < MIN_DISK_MB)); then
    say "Refusing to install: Morphix needs about 2 GB free under $dir and there is ${DISK_MB} MB." >&2
    return 6
  fi
  return 0
}

# MORPHIX_ASSUME_SYSTEMD=1: for the end-to-end test, which fakes systemctl.
has_systemd() { [[ "${MORPHIX_ASSUME_SYSTEMD:-0}" == 1 || -d /run/systemd/system ]]; }

set_paths() {
  if [[ "$SCOPE" == system ]]; then
    APP_ROOT=/opt/morphix DATA_DIR=/var/lib/morphix CONF_DIR=/etc/morphix
    CLI=/usr/local/bin/morphix KIOSK_BIN=/usr/local/bin/morphix-kiosk
    UNIT_DIR=/etc/systemd/system SERVICE_USER=morphix
  else
    local data="${XDG_DATA_HOME:-$HOME/.local/share}"
    APP_ROOT="$data/morphix-app" DATA_DIR="$data/morphix" CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/morphix"
    CLI="$HOME/.local/bin/morphix" KIOSK_BIN="$HOME/.local/bin/morphix-kiosk"
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user" SERVICE_USER="$(id -un)"
  fi
  CONF_FILE="$CONF_DIR/install.conf" ENV_FILE="$CONF_DIR/morphix.env"
}

# Writes to the system dirs go through root; user installs write as the user.
priv() { if [[ "$SCOPE" == system ]]; then as_root "$@"; else run "$@"; fi; }
sctl() { if [[ "$SCOPE" == system ]]; then as_root systemctl "$@"; else run systemctl --user "$@"; fi; }

# Runs as the account that owns the app files.
as_app() {
  if [[ "$SCOPE" == system ]]; then
    if [[ "$DRY_RUN" == 1 ]]; then printf '[dry-run] (as %s) %s\n' "$SERVICE_USER" "$*"
    elif [[ "$(id -u)" -eq 0 ]]; then runuser -u "$SERVICE_USER" -- env HOME="$APP_ROOT" "$@"
    else sudo -u "$SERVICE_USER" -- env HOME="$APP_ROOT" "$@"; fi
  else run "$@"; fi
}

# -------------------------------------------------------------- packages ---
# Prints the distro packages for the commands that are missing.
missing_packages() {
  local -a pkgs=()
  local cmd
  for cmd in git curl xz tar make g++ python3 flock; do
    command -v "$cmd" >/dev/null 2>&1 && continue
    case "$PKG:$cmd" in
      apt:xz) pkgs+=(xz-utils) ;;
      apt:make | apt:g++) pkgs+=(build-essential) ;;
      dnf:make) pkgs+=(make) ;;
      dnf:g++) pkgs+=(gcc-c++) ;;
      pacman:make | pacman:g++) pkgs+=(base-devel) ;;
      pacman:python3) pkgs+=(python) ;;
      *:flock) pkgs+=(util-linux) ;;
      *) pkgs+=("$cmd") ;;
    esac
  done
  if ((${#pkgs[@]})); then pkgs+=(ca-certificates); printf '%s\n' "${pkgs[@]}" | sort -u | tr '\n' ' '; fi
  return 0
}

pkg_install() {
  (($#)) || return 0
  [[ "$(id -u)" -eq 0 || "$DRY_RUN" == 1 ]] || command -v sudo >/dev/null 2>&1 ||
    die "missing packages ($*) and no sudo; ask an admin to install them, then re-run"
  case "$PKG" in
    apt)
      as_root apt-get update -qq
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" ;;
    dnf) as_root dnf install -y -q "$@" ;;
    pacman) as_root pacman -S --needed --noconfirm "$@" ;;
  esac
}

install_packages() {
  step "System packages ($OS_NAME, $PKG)"
  local missing
  missing="$(missing_packages)"
  if [[ -n "$missing" ]]; then
    say "Installing: $missing"
    # shellcheck disable=SC2086 # package list
    pkg_install $missing
  else
    say "git, curl, build tools: already installed"
  fi
}

install_prusaslicer() {
  step "PrusaSlicer"
  if command -v prusa-slicer >/dev/null 2>&1; then say "already installed: $(command -v prusa-slicer)"
  else pkg_install prusa-slicer || warn "could not install prusa-slicer from $PKG; install it by hand or use another slicer"; fi
  cat <<'EOF'
Other slicers (optional): OrcaSlicer and Bambu Studio publish Linux AppImages / Flatpaks on their
GitHub release pages (check that a build exists for your CPU). For the system service, put the
AppImage outside /home (e.g. /opt/orca-slicer/) so the hardened service can run it, then set its
path on Morphix's setup page.
EOF
}

# Optional helpers the app looks for: espeak-ng (offline spoken warnings) and Python with
# OpenCV + numpy (the camera print guardian). Both are plain distro packages.
install_extras() {
  step "Extras (offline speech, print guardian)"
  case "$PKG" in
    apt) pkg_install espeak-ng python3-opencv python3-numpy ;;
    dnf) pkg_install espeak-ng python3-opencv python3-numpy ;;
    pacman) pkg_install espeak-ng python-opencv python-numpy ;;
  esac || warn "could not install the extras; Morphix works without them"
}

# ------------------------------------------------------------------- node ---
# Uses a Node >= NODE_LINE already on PATH (not under /home for the system service, which
# can't see home dirs), else downloads the official LTS build and checks its SHA-256.
ensure_node() {
  step "Node.js $NODE_LINE+"
  local existing v
  existing="$(command -v node || true)"
  if [[ -n "$existing" ]]; then
    existing="$(readlink -f "$existing")"
    v="$(node -v 2>/dev/null || echo v0)"
    v="${v#v}"
    if [[ "${v%%.*}" =~ ^[0-9]+$ ]] && ((${v%%.*} >= NODE_LINE)) && [[ -x "$(dirname "$existing")/npm" ]] &&
      ! { [[ "$SCOPE" == system ]] && [[ "$existing" == /home/* || "$existing" == /root/* ]]; }; then
      NODE_DIR="$(dirname "$existing")"
      say "using Node.js v$v at $existing"
      return 0
    fi
  fi
  local base="https://nodejs.org/dist/latest-v${NODE_LINE}.x" root="$APP_ROOT/node"
  if [[ -x "$root/current/bin/node" ]]; then
    NODE_DIR="$root/current/bin"
    say "using Node.js $("$NODE_DIR/node" -v) at $NODE_DIR"
    return 0
  fi
  NODE_DIR="$root/current/bin"
  if [[ "$DRY_RUN" == 1 ]]; then
    say "[dry-run] download Node.js $NODE_LINE LTS (linux-$NODE_ARCH) from $base, verify it against SHASUMS256.txt, unpack to $root"
    return 0
  fi
  local sums line file sum tmp
  sums="$(curl -fsSL --max-time 60 "$base/SHASUMS256.txt")" || die "could not reach nodejs.org; check the network"
  line="$(printf '%s\n' "$sums" | grep -E "  node-v[0-9.]+-linux-${NODE_ARCH}\.tar\.xz$" | head -n 1)"
  [[ -n "$line" ]] || die "nodejs.org has no Node.js $NODE_LINE build for linux-$NODE_ARCH"
  sum="${line%% *}" file="${line##* }"
  tmp="$(mktemp -d)"
  say "Downloading $file"
  curl -fsSL --max-time 600 -o "$tmp/$file" "$base/$file" || { rm -rf "$tmp"; die "download of $file failed"; }
  if ! (cd "$tmp" && printf '%s  %s\n' "$sum" "$file" | sha256sum -c --quiet -); then
    rm -rf "$tmp"; die "$file does not match its SHA-256 from nodejs.org; not installing it"
  fi
  as_app mkdir -p "$root"
  as_app tar -xJf "$tmp/$file" -C "$root"
  as_app ln -sfn "$root/${file%.tar.xz}" "$root/current"
  rm -rf "$tmp"
  say "installed $("$NODE_DIR/node" -v) (SHA-256 verified)"
}

# ------------------------------------------------------------- user, dirs ---
ensure_service_user() {
  [[ "$SCOPE" == system ]] || return 0
  step "Service account"
  if id "$SERVICE_USER" >/dev/null 2>&1; then say "user $SERVICE_USER exists"
  else
    as_root useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home \
      --shell "$(command -v nologin || echo /usr/sbin/nologin)" --comment "Morphix server" "$SERVICE_USER"
  fi
  local g
  # dialout (Debian/Fedora) or uucp (Arch): USB serial printers; video: USB cameras
  for g in dialout uucp video; do
    if getent group "$g" >/dev/null 2>&1; then
      if id -nG "$SERVICE_USER" 2>/dev/null | tr ' ' '\n' | grep -qx "$g"; then continue; fi
      as_root usermod -aG "$g" "$SERVICE_USER"
    fi
  done
}

ensure_dirs() {
  step "Folders"
  if [[ "$SCOPE" == system ]]; then
    as_root install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$APP_ROOT" "$APP_ROOT/releases"
    as_root install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
    as_root install -d -m 0755 "$CONF_DIR"
  else
    run install -d -m 0755 "$APP_ROOT" "$APP_ROOT/releases" "$(dirname "$CLI")" "$UNIT_DIR"
    run install -d -m 0700 "$DATA_DIR" "$CONF_DIR"
  fi
  # an existing data dir keeps its contents but gets the right mode
  priv chmod 0700 "$DATA_DIR"
  say "app: $APP_ROOT  data: $DATA_DIR (0700)  config: $CONF_DIR"
}

# ----------------------------------------------------------------- source ---
fetch_source() {
  step "Source ($REPO_URL)"
  if [[ -d "$APP_ROOT/src/.git" ]]; then
    as_app git -C "$APP_ROOT/src" remote set-url origin "$REPO_URL"
    as_app git -C "$APP_ROOT/src" fetch --quiet --tags --prune origin
  else
    as_app git clone --quiet --no-checkout "$REPO_URL" "$APP_ROOT/src"
  fi
}

# A file from the source at origin/main (the CLI and unit templates bootstrap from there;
# `morphix update` then installs the deployed release's own CLI).
src_file() {
  as_app git -C "$APP_ROOT/src" show "origin/main:$1"
}

install_cli() {
  step "morphix command"
  if [[ "$DRY_RUN" == 1 ]]; then say "[dry-run] install $CLI (from scripts/install/morphix)"; return 0; fi
  src_file scripts/install/morphix | write_file "$CLI" 0755 "" "$([[ "$SCOPE" == system ]] && echo 1 || echo 0)"
  say "installed $CLI"
}

# Reads one key from an existing install.conf (re-runs keep the user's channel and port).
existing_conf() {
  [[ -r "$CONF_FILE" ]] || return 0
  grep -E "^$1=" "$CONF_FILE" | tail -n 1 | cut -d= -f2- || true
}

write_config() {
  step "Configuration"
  CHANNEL="${CHANNEL_ARG:-$(existing_conf CHANNEL)}"; CHANNEL="${CHANNEL:-stable}"
  PORT="${PORT_ARG:-$(existing_conf PORT)}"; PORT="${PORT:-8080}"
  local root=0; [[ "$SCOPE" == system ]] && root=1
  write_file "$CONF_FILE" 0644 "" "$root" <<EOF
# Written by the Morphix installer $INSTALLER_VERSION; read by the morphix command.
MODE=$SCOPE
APP_ROOT=$APP_ROOT
DATA_DIR=$DATA_DIR
ENV_FILE=$ENV_FILE
NODE_DIR=$NODE_DIR
REPO_URL=$REPO_URL
CHANNEL=$CHANNEL
PORT=$PORT
SERVICE_USER=$SERVICE_USER
EOF
  if [[ -f "$ENV_FILE" && -z "$PORT_ARG" ]]; then
    say "keeping $ENV_FILE"
  else
    local owner=""; [[ "$SCOPE" == system ]] && owner="root:$SERVICE_USER"
    write_file "$ENV_FILE" 0640 "$owner" "$root" <<EOF
# Morphix server settings. No secrets here: API keys and passwords are set on the setup page
# and stored in the data dir (mode 0600). After a change: morphix restart
MORPHIX_PORT=$PORT
# 0.0.0.0 = reachable from the network; 127.0.0.1 = this machine only
MORPHIX_BIND=0.0.0.0
EOF
  fi
}

render_unit() {
  sed -e "s|@APP_ROOT@|$APP_ROOT|g" -e "s|@DATA_DIR@|$DATA_DIR|g" -e "s|@ENV_FILE@|$ENV_FILE|g" \
    -e "s|@NODE@|$NODE_DIR/node|g" -e "s|@USER@|$SERVICE_USER|g" -e "s|@CLI@|$CLI|g" -e "s|@SCOPE@|$SCOPE|g"
}

install_units() {
  step "systemd service"
  local root=0 template=morphix-user.service.in
  [[ "$SCOPE" == system ]] && root=1 template=morphix.service.in
  if [[ "$DRY_RUN" == 1 ]]; then
    say "[dry-run] install $UNIT_DIR/morphix.service (from packaging/systemd/$template), morphix-update.service, morphix-update.timer"
  else
    src_file "packaging/systemd/$template" | render_unit | write_file "$UNIT_DIR/morphix.service" 0644 "" "$root"
    src_file packaging/systemd/morphix-update.service.in | render_unit | write_file "$UNIT_DIR/morphix-update.service" 0644 "" "$root"
    src_file packaging/systemd/morphix-update.timer.in | render_unit | write_file "$UNIT_DIR/morphix-update.timer" 0644 "" "$root"
  fi
  sctl daemon-reload
  sctl enable morphix.service
  if [[ "$AUTO_UPDATE" == 1 ]]; then sctl enable morphix-update.timer; say "automatic nightly updates: on"
  else say "automatic updates: off (turn on with: morphix auto-update on)"; fi
  if [[ "$SCOPE" == user ]]; then
    # without lingering a user service only runs while you are logged in
    if [[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]]; then
      run loginctl enable-linger "$(id -un)" || warn "could not enable lingering; Morphix starts only after you log in (fix: sudo loginctl enable-linger $(id -un))"
    fi
  fi
}

first_deploy() {
  step "Build and start (npm ci, tests, build; several minutes on a Raspberry Pi)"
  local -a args=(update --channel "$CHANNEL")
  [[ "$SKIP_TESTS" == 1 ]] && args+=(--skip-tests)
  [[ "$FORCE" == 1 ]] && args+=(--force)
  if [[ "$DRY_RUN" == 1 ]]; then say "[dry-run] $CLI ${args[*]}"; return 0; fi
  if [[ "$SCOPE" == system && "$(id -u)" -ne 0 ]]; then
    sudo env MORPHIX_INSTALL_CONF="$CONF_FILE" "$CLI" "${args[@]}"
  else
    MORPHIX_INSTALL_CONF="$CONF_FILE" "$CLI" "${args[@]}"
  fi
}

# ------------------------------------------------------------------ kiosk ---
install_kiosk() {
  step "Kiosk (full-screen browser on this machine's display)"
  local user="${KIOSK_USER:-}"
  if [[ -z "$user" ]]; then
    if [[ "$SCOPE" == user ]]; then user="$(id -un)"; else user="${SUDO_USER:-}"; fi
  fi
  [[ -n "$user" && "$user" != root ]] || { warn "--kiosk: say which desktop account logs in on the screen with --kiosk-user NAME"; return 0; }
  local home="$HOME"
  [[ "$SCOPE" == system ]] && home="$(getent passwd "$user" | cut -d: -f6)"
  [[ -n "$home" ]] || { warn "--kiosk: no user $user"; return 0; }
  local browser=chromium font=fonts-noto-color-emoji
  case "$PKG" in
    apt)
      # Raspberry Pi OS and older Debian call it chromium-browser
      if ! apt-cache show chromium >/dev/null 2>&1 && apt-cache show chromium-browser >/dev/null 2>&1; then browser=chromium-browser; fi ;;
    dnf) font=google-noto-color-emoji-fonts ;;
    pacman) font=noto-fonts-emoji ;;
  esac
  if command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then say "chromium: already installed"
  else pkg_install "$browser" "$font" || warn "could not install $browser; install a Chromium browser by hand"; fi
  local root=0; [[ "$SCOPE" == system ]] && root=1
  if [[ "$DRY_RUN" == 1 ]]; then say "[dry-run] install $KIOSK_BIN (from scripts/install/morphix-kiosk)"
  else src_file scripts/install/morphix-kiosk | write_file "$KIOSK_BIN" 0755 "" "$root"; fi
  local owner=""; [[ "$SCOPE" == system ]] && owner="$user:$(id -gn "$user" 2>/dev/null || echo "$user")"
  write_file "$home/.config/autostart/morphix-kiosk.desktop" 0644 "$owner" "$root" <<EOF
[Desktop Entry]
Type=Application
Name=Morphix kiosk
Comment=Opens Morphix full screen at login (installed by the Morphix installer --kiosk)
Exec=env MORPHIX_PORT=$PORT $KIOSK_BIN
X-GNOME-Autostart-enabled=true
EOF
  say "Morphix opens full screen when $user logs in on the display (desktop autologin recommended)."
}

# ------------------------------------------------------------- uninstall ---
do_uninstall() {
  step "Uninstall Morphix ($SCOPE install)"
  [[ -f "$CONF_FILE" || -d "$APP_ROOT" || -f "$UNIT_DIR/morphix.service" ]] ||
    { say "Morphix is not installed here ($CONF_FILE not found)."; [[ "$SCOPE" == system ]] && say "A --user install? Run with --uninstall --user."; return 0; }
  confirm "Remove the Morphix service, app files ($APP_ROOT) and the morphix command? Your data in $DATA_DIR is kept." ||
    die "cancelled"
  if [[ -f "$UNIT_DIR/morphix.service" ]]; then
    sctl disable --now morphix-update.timer 2>/dev/null || true
    sctl disable --now morphix.service || true
  fi
  priv rm -f "$UNIT_DIR/morphix.service" "$UNIT_DIR/morphix-update.service" "$UNIT_DIR/morphix-update.timer"
  sctl daemon-reload || true
  priv rm -rf "$APP_ROOT"
  priv rm -f "$CLI" "$KIOSK_BIN" "$CONF_FILE" "$ENV_FILE"
  priv rmdir "$CONF_DIR" 2>/dev/null || true
  local kiosk_home
  for kiosk_home in "$HOME" ${SUDO_USER:+"$(getent passwd "$SUDO_USER" | cut -d: -f6)"}; do
    [[ -f "$kiosk_home/.config/autostart/morphix-kiosk.desktop" ]] && priv rm -f "$kiosk_home/.config/autostart/morphix-kiosk.desktop"
  done
  if [[ "$PURGE" == 1 ]]; then
    if [[ "$ASSUME_YES" != 1 && "$DRY_RUN" != 1 ]]; then
      local answer=""
      have_tty || die "no terminal to confirm --purge; add --yes"
      printf 'Delete ALL Morphix data in %s (models, settings, API keys)? This cannot be undone. Type delete: ' "$DATA_DIR" >/dev/tty
      read -r answer </dev/tty || true
      [[ "$answer" == delete ]] || { say "Data kept in $DATA_DIR."; return 0; }
    fi
    priv rm -rf "$DATA_DIR"
    if [[ "$SCOPE" == system ]] && id "$SERVICE_USER" >/dev/null 2>&1; then as_root userdel "$SERVICE_USER" || true; fi
    say "Morphix and its data are removed."
  else
    say "Morphix is removed. Your data is still in $DATA_DIR (delete it with --uninstall --purge)."
  fi
  say "System packages (git, build tools, Node.js from your distro) were left installed."
}

# ------------------------------------------------------------------ hints ---
old_layout_hint() {
  local old_home="${SUDO_USER:+$(getent passwd "$SUDO_USER" | cut -d: -f6)}"
  old_home="${old_home:-$HOME}"
  if [[ -d "$old_home/Morphix" || -f "$old_home/.config/systemd/user/morphix.service" ]]; then
    warn "found the old Raspberry Pi setup ($old_home/Morphix). See \"Moving from the old Pi setup\" in docs/INSTALL.md to stop the old services and move your data."
  fi
}

lan_urls() {
  local ip
  for ip in $( (hostname -I 2>/dev/null || ip -o -4 addr show scope global 2>/dev/null | awk '{sub(/\/.*/,"",$4); print $4}') | tr ' ' '\n' | grep -E '^[0-9]+\.' || true); do
    printf '  http://%s:%s\n' "$ip" "$PORT"
  done
  printf '  http://%s.local:%s  (if your network has mDNS)\n' "$(hostname 2>/dev/null || echo localhost)" "$PORT"
}

firewall_hint() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    say "Firewall: sudo ufw allow $PORT/tcp"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    say "Firewall: sudo firewall-cmd --permanent --add-port=$PORT/tcp && sudo firewall-cmd --reload"
  fi
  return 0
}

finish() {
  step "Done"
  say "Open Morphix from any device on your network:"
  lan_urls
  say ""
  say "The first visit opens the setup page (admin password, API keys, printer, slicer)."
  firewall_hint
  say "Check everything: morphix doctor    Logs: morphix logs -f    Update: morphix update"
  [[ "$SCOPE" == user && ":$PATH:" != *":$HOME/.local/bin:"* ]] && say "(add ~/.local/bin to your PATH to use the morphix command)"
  return 0
}

# ------------------------------------------------------------------- main ---
main() {
  parse_args "$@" || exit 2
  local mode_note=""
  [[ "$DRY_RUN" == 1 ]] && mode_note=", dry run: nothing is changed"
  say "Morphix installer $INSTALLER_VERSION ($SCOPE install$mode_note)"
  [[ "$(uname -s)" == Linux ]] || die "Morphix installs on Linux; on other systems use Docker (docker-compose.yml)"
  local rc=0
  detect_os || rc=$?
  ((rc == 0)) || exit "$rc"
  detect_arch || exit $?
  say "System: $OS_NAME, $ARCH"
  set_paths
  if [[ "$UNINSTALL" == 1 ]]; then do_uninstall; return 0; fi
  if [[ "$SCOPE" == user && "$(id -u)" -eq 0 ]]; then die "--user installs for a normal account; don't run it as root"; fi
  check_ram || exit $?
  check_disk "$APP_ROOT" || exit $?
  say "RAM: ${RAM_MB} MB, free disk: ${DISK_MB} MB"
  if ! has_systemd; then
    if [[ "$DRY_RUN" == 1 ]]; then warn "systemd is not running here; a real install needs it (or use Docker)"
    else die "systemd is not running (container or WSL?); use Docker (docker-compose.yml) or start the server by hand (docs/INSTALL.md)"; fi
  fi
  if [[ "$SCOPE" == system && "$(id -u)" -ne 0 && "$DRY_RUN" != 1 ]]; then
    command -v sudo >/dev/null 2>&1 || die "a system install needs root: run as root, or use --user"
    say "A system install needs root; sudo may ask for your password."
    sudo -v || die "sudo failed; run as root, or use --user"
  fi
  old_layout_hint
  install_packages
  [[ "$WITH_PRUSA" == 1 ]] && install_prusaslicer
  [[ "$WITH_EXTRAS" == 1 ]] && install_extras
  ensure_service_user
  ensure_dirs
  ensure_node
  fetch_source
  install_cli
  write_config
  install_units
  first_deploy
  [[ "$KIOSK" == 1 ]] && install_kiosk
  finish
}

if [[ "${MORPHIX_INSTALL_SOURCE_ONLY:-0}" != 1 ]]; then main "$@"; fi
