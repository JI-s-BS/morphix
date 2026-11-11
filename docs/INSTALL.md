# Installing Morphix

Morphix runs as a small web server on a Linux machine next to your printer: a Raspberry Pi, an
old PC, a mini PC or a VM. You use it from a browser on any device on your network. A screen on
the machine itself is optional (see [Kiosk](#touchscreen-kiosk)).

- [Requirements](#requirements)
- [One-line install](#one-line-install)
- [Raspberry Pi](#raspberry-pi) · [Old PC / mini PC](#old-pc-or-mini-pc) · [VM](#virtual-machine) · [Docker](#docker) · [Other Linux](#other-linux)
- [Everyday commands](#everyday-commands) · [Updates](#updates) · [Rollback](#rollback) · [Backup](#backup-and-restore) · [Uninstall](#uninstall)
- [Troubleshooting](#troubleshooting) · [Moving from the old Pi setup](#moving-from-the-old-pi-setup) · [What goes where](#what-goes-where)

## Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Debian 12+, Ubuntu 22.04+, Raspberry Pi OS (Bookworm+), Fedora 40+, Arch | 64-bit |
| CPU | x86_64, aarch64 (arm64), armv7l | x86_64 or a Raspberry Pi 4/5 |
| RAM | 1 GB (add swap) | 2 GB or more |
| Disk | 2 GB free | 4 GB (slicers, models, 3 releases for rollback) |
| Init | systemd (or use Docker) | |

Not supported: Raspberry Pi Zero / Zero W / Pi 1 (ARMv6). Node.js 22 has no build for them and
they are too small to build Morphix. A Pi Zero 2 W works but is slow; use a 64-bit OS.

The installer brings everything else: git, build tools and Node.js 22 LTS (the official build
from nodejs.org, checked against its published SHA-256, unless your system already has Node 22+).

## One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/JI-s-BS/morphix/main/scripts/install/install.sh | bash
```

That installs a **system service** (it asks for your sudo password). When it finishes it prints
the address to open, for example `http://192.168.1.20:8080`. The first visit opens the setup
page: choose an admin password, add API keys, pick your printer, test the connection, pick a slicer.

Want to read the script first (a good habit)? Download, read, then run:

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/JI-s-BS/morphix/main/scripts/install/install.sh
```

```bash
bash install.sh --dry-run
```

`--dry-run` shows every command it would run and changes nothing. Options go after `bash -s --`
when piping, e.g. `curl -fsSL …/install.sh | bash -s -- --user --with-prusaslicer`.

| Option | What it does |
|---|---|
| `--user` | Install for your account only, no root: app in `~/.local/share/morphix-app`, data in `~/.local/share/morphix`, a systemd user service |
| `--channel stable\|main` | `stable` (default) = newest release tag; `main` = latest code |
| `--with-prusaslicer` | Also install PrusaSlicer from your distro |
| `--with-extras` | espeak-ng (spoken print warnings without internet) and Python OpenCV (camera print guardian) |
| `--kiosk` | Open Morphix full screen on this machine's display at login |
| `--auto-update` | Turn on nightly updates (off by default; never during a print) |
| `--port N` | Web port (default 8080) |
| `--skip-tests` | Skip the test suite before the first start (faster on a Pi) |
| `--dry-run`, `--yes`, `--force` | Show only / don't ask / continue on low RAM and rebuild |
| `--uninstall [--purge]` | Remove Morphix; `--purge` also deletes your data |

Re-running the installer is safe: it skips what is already done and keeps your settings.

### System or user install?

- **System (default)**: runs as its own `morphix` account at boot, whether or not anyone is
  logged in. That account can only write `/var/lib/morphix`; the service is sandboxed
  (`ProtectSystem=strict`, `NoNewPrivileges`, private `/tmp`, no home dirs). It is in the
  `dialout`/`uucp` group for USB printers and `video` for USB cameras. Best for a dedicated box.
- **User (`--user`)**: runs as you, no root needed for Morphix itself (packages may still need
  sudo). It starts at boot only with "lingering", which the installer turns on
  (`loginctl enable-linger`). Good on a shared desktop or when you have no admin rights.

## Raspberry Pi

1. Flash **Raspberry Pi OS (64-bit)**, Lite is fine (no desktop needed), with Raspberry Pi Imager.
   Set a hostname (e.g. `morphix`), your Wi-Fi and enable SSH in the Imager settings.
2. `ssh pi@morphix.local`, then run the one-line install. On a Pi 4 the first build takes about
   10–15 minutes; add `--skip-tests` to save a few.
3. Open `http://morphix.local:8080` from your phone or laptop.

With 1 GB of RAM (Pi 3), enlarge swap first:
`sudo dphys-swapfile swapoff && sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile && sudo dphys-swapfile setup && sudo dphys-swapfile swapon`.

### Touchscreen kiosk

With a screen attached and the desktop version of Raspberry Pi OS (or any desktop Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/JI-s-BS/morphix/main/scripts/install/install.sh | bash -s -- --kiosk
```

It installs Chromium and an autostart entry for the account that ran the installer (choose
another with `--kiosk-user NAME`). Turn on desktop autologin (`sudo raspi-config` → System →
Boot / Auto Login) so the screen shows Morphix after a reboot. The kiosk is just a browser on
`http://localhost:8080`; the server runs the same with or without it.

## Old PC or mini PC

Install Debian, Ubuntu Server or Fedora (no desktop needed), then run the one-line install.
Give the machine a fixed address in your router (DHCP reservation) so the URL doesn't change.

## Virtual machine

Any of the supported distros in a VM works (Proxmox, VirtualBox, UTM, Hyper-V…). Use **bridged
networking** so the VM gets its own address on your LAN (with NAT the printer can't be reached
and your phone can't reach Morphix). For a USB printer, pass the USB device through to the VM.

## Docker

```bash
git clone https://github.com/JI-s-BS/morphix.git && cd morphix
```

```bash
docker compose up -d
```

Then open `http://<machine>:8080`. Data lives in the `morphix-data` volume. The image runs as an
unprivileged `morphix` user and has a health check (`docker ps` shows "healthy").

- **USB printer:** uncomment `devices:` (and `group_add:` if needed) in `docker-compose.yml`.
  Find the device with `ls -l /dev/serial/by-id/`.
- **Printer discovery:** auto-discovery broadcasts don't cross Docker's network; type the
  printer's IP on the setup page, or use `network_mode: host` (see the comments in the file).
- **PrusaSlicer in the image:** set `WITH_PRUSASLICER: "1"` under `build.args` (adds ~400 MB).
- **Update:** `git pull && docker compose up -d --build`. **Logs:** `docker compose logs -f`.
- **Reset admin password:** `docker compose exec morphix node apps/server/dist/server.cjs reset-admin`.
- **Other architectures:** the image builds for linux/amd64, linux/arm64 and linux/arm/v7:
  `docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 -t morphix .`

## Other Linux

The installer stops on other distros (openSUSE, Alpine, Gentoo, NixOS…) and prints these steps:

1. Install git, curl, xz, tar, make, a C++ compiler, python3 and Node.js 22+.
2. `git clone https://github.com/JI-s-BS/morphix.git && cd morphix`
3. `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci && npm run build && npm run build:server`
4. `MORPHIX_DATA_DIR=$HOME/.local/share/morphix node apps/server/dist/server.cjs`

Make step 4 a service with your init system, or use Docker.

## Everyday commands

The installer adds a `morphix` command (`/usr/local/bin`, or `~/.local/bin` for `--user`).
For a system install, commands that change things ask for sudo by themselves.

| Command | |
|---|---|
| `morphix status` | Service state, version, health, the address to open |
| `morphix start` / `stop` / `restart` | Control the service |
| `morphix logs` / `morphix logs -f` / `morphix logs -n 500` | Server log (from journald) |
| `morphix update` | Update to the newest version (below) |
| `morphix rollback` | Go back to the previous version |
| `morphix doctor` | Check everything; each problem comes with a fix |
| `morphix backup` / `morphix restore FILE` | Save / restore your data |
| `morphix reset-admin` | Set a new admin password |
| `morphix auto-update on\|off\|status` | Nightly updates |
| `morphix version` | CLI, release and Node.js versions |

Server settings (port, bind address) are in `/etc/morphix/morphix.env` (user install:
`~/.config/morphix/morphix.env`); run `morphix restart` after changing them. API keys and
passwords are **not** in that file: set them on the setup page (Settings), which stores them in
the data dir with mode 0600 and only ever shows "set / not set".

## Updates

```bash
morphix update
```

What it does, in order (the running version is untouched until the last step):

1. Fetches the code (`stable` = newest release tag; `main` with `--channel main`, remembered).
2. Builds it in a new folder `releases/<commit>`: `npm ci`, the test suite (`--skip-tests` to
   skip), the build. Any failure stops here and nothing changes.
3. Waits while Morphix is busy: a print it is streaming, a slice, a design or an upload.
   It waits up to 60 minutes (`--wait MIN`), then gives up without restarting.
4. Points `current` at the new release, restarts, and checks `http://127.0.0.1:8080/api/health`.
5. If the health check fails, it switches straight back to the previous release, restarts it,
   and remembers the bad version so it isn't tried again (`morphix update --force` retries).

Old releases are pruned to the newest three (plus the previous one).

**Automatic updates** are off by default. `morphix auto-update on` (or install with
`--auto-update`) runs `morphix update --auto` nightly around 03:30. It never starts while a
print or job is running (it doesn't even build, to keep the CPU free) and skips the night if
Morphix stays busy. Turn it off with `morphix auto-update off`.

## Rollback

```bash
morphix rollback
```

goes back to the previous release (same health check). `morphix rollback <commit>` picks a
specific one from `ls /opt/morphix/releases`. Your data is not touched by updates or rollbacks.

## Backup and restore

```bash
morphix backup
```

writes `morphix-backup-<date>.tar.gz` (mode 0600) with your settings, printers, models and jobs.
**API keys and the admin password are left out** unless you add `--include-secrets`; keep such
a file private. `morphix restore FILE` stops Morphix, keeps the current data as
`<data dir>.before-restore-<date>`, unpacks the backup and starts Morphix again. Without the
secrets, enter your API keys again on the setup page and set a password with `morphix reset-admin`.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/JI-s-BS/morphix/main/scripts/install/install.sh | bash -s -- --uninstall
```

Removes the service, timer, app files and the `morphix` command, and **keeps your data**
(`/var/lib/morphix` or `~/.local/share/morphix`). Add `--purge` to also delete the data and the
`morphix` account; it asks you to type `delete` first. Add `--user` for a user install. System
packages (git, build tools, PrusaSlicer) stay installed.

## Troubleshooting

Start with:

```bash
morphix doctor
```

It checks Node.js, the release, the service, the health endpoint, the port, data dir
permissions, disk space, slicers and USB printer permissions, and prints a fix for each problem.

| Problem | Fix |
|---|---|
| Page doesn't load from another device | `morphix status` shows the address. Open the port in the firewall (the installer prints the command for ufw/firewalld). Same Wi-Fi / no guest network? |
| `service is failed` | `morphix logs -n 100` shows why; then `morphix restart` |
| Port 8080 taken | Set `MORPHIX_PORT=8090` in `morphix.env` and `PORT=8090` in `install.conf` (same folder), `morphix restart` |
| USB printer not found / permission denied | `morphix doctor` names the group (`dialout` or `uucp`); `sudo usermod -aG dialout morphix`, `morphix restart` |
| Slicer not found | Re-run the installer with `--with-prusaslicer`, or set its path on the setup page. For the system service put AppImages under `/opt`, not your home folder (the service can't see home folders) |
| Build killed / out of memory on a Pi | Add swap (see [Raspberry Pi](#raspberry-pi)), then `morphix update --force` |
| Update keeps waiting | A print or job is running; `morphix status` shows what. It never restarts in the middle |
| Broke after an update | It rolls back by itself when the health check fails; otherwise `morphix rollback` |
| Forgot the admin password | `morphix reset-admin` |

## Moving from the old Pi setup

The original Pi build ran Morphix as Electron from a git checkout (`~/3D-AI-PRINT` or similar)
with `systemd --user` units (`morphix.service`, `qd330-web.service`), `deploy.sh`, data in
`~/Morphix` and keys in `~/Morphix/config/morphix.env`. Those scripts (`scripts/pi/*`,
`deploy.sh`) are gone; to move:

1. Stop and remove the old user services:
   ```bash
   systemctl --user disable --now morphix.service qd330-web.service
   ```
   then `rm ~/.config/systemd/user/{morphix,qd330-web}.service ~/.local/bin/qd330ctl ~/.local/share/applications/morphix.desktop && systemctl --user daemon-reload`.
2. Back up the old data: `tar -czf ~/morphix-old-$(date +%F).tar.gz -C ~ Morphix` (mode
   matters: `chmod 600` it, it holds your API keys).
3. Install: the one-line install (add `--kiosk` to keep the touchscreen, `--with-extras` for the
   offline voice and print guardian).
4. Copy your models, jobs and database into the new data dir (it uses the same layout, since the
   service sets `MORPHIX_ROOT` to the data dir):
   ```bash
   sudo rsync -a --exclude config/morphix.env --exclude run ~/Morphix/ /var/lib/morphix/ && sudo chown -R morphix: /var/lib/morphix && morphix restart
   ```
   (user install: `rsync -a --exclude config/morphix.env --exclude run ~/Morphix/ ~/.local/share/morphix/`).
5. Open the setup page and enter the keys from `~/Morphix/config/morphix.env` (Gemini, Meshy,
   Anthropic, Thingiverse) and your printer. Keys now live in the data dir with mode 0600 and
   are never shown again. Printer settings such as `MORPHIX_PRINTER_HOST` become the printer you
   add on the setup page (Afinia QD330 / FlashForge LAN driver).
6. When everything works, delete `~/Morphix/config/morphix.env` (and the old checkout) so no
   copy of the keys is left lying around.

`~/.local/share/morphix-tts` and `~/.local/share/morphix-vision` from the old helper scripts
still work for a user install; `--with-extras` installs the distro packages instead.

## What goes where

| | System install | User install (`--user`) |
|---|---|---|
| App releases | `/opt/morphix/releases/<commit>`, `/opt/morphix/current` → active | `~/.local/share/morphix-app/…` |
| Git cache, Node.js (if downloaded) | `/opt/morphix/src`, `/opt/morphix/node` | `~/.local/share/morphix-app/…` |
| Data (settings, keys 0600, models, jobs) | `/var/lib/morphix` (0700, owner `morphix`) | `~/.local/share/morphix` (0700) |
| Config | `/etc/morphix/install.conf`, `/etc/morphix/morphix.env` | `~/.config/morphix/…` |
| Service | `/etc/systemd/system/morphix.service` | `~/.config/systemd/user/morphix.service` |
| Updates timer | `morphix-update.timer` (off until you turn it on) | same, user unit |
| CLI | `/usr/local/bin/morphix` | `~/.local/bin/morphix` |

The server is `node <current>/apps/server/dist/server.cjs` with `MORPHIX_DATA_DIR`,
`MORPHIX_PORT` (8080) and `MORPHIX_BIND` (0.0.0.0). While it is working it keeps
`<data>/run/busy` (and `<data>/run/printing` while a print depends on it) fresh; updates wait
for both.
