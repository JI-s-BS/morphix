// Shared helpers for the installer tests: run bash scripts with a fake PATH, a temp HOME and
// fake /etc/os-release, /proc/meminfo and uname, so nothing on the real machine is touched.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(__dirname, "..");
export const INSTALL_SH = join(ROOT, "scripts/install/install.sh");
export const CLI = join(ROOT, "scripts/install/morphix");
export const KIOSK = join(ROOT, "scripts/install/morphix-kiosk");

export interface Run { status: number; stdout: string; stderr: string; out: string }

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `morphix-${prefix}-`));
}

/** Writes an executable script into dir/name. */
export function fakeBin(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

export function bash(args: string[], env: Record<string, string>, opts: { cwd?: string; timeout?: number; input?: string } = {}): Run {
  const r = spawnSync("bash", args, {
    cwd: opts.cwd ?? ROOT,
    env: { LANG: "C", ...env },
    encoding: "utf8",
    timeout: opts.timeout ?? 30_000,
    input: opts.input ?? "",
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { status: r.status ?? -1, stdout, stderr, out: stdout + stderr };
}

export const OS = {
  debian: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\n',
  ubuntu: 'PRETTY_NAME="Ubuntu 24.04 LTS"\nID=ubuntu\nID_LIKE=debian\n',
  raspbian: 'PRETTY_NAME="Raspbian GNU/Linux 12 (bookworm)"\nID=raspbian\nID_LIKE=debian\n',
  fedora: 'PRETTY_NAME="Fedora Linux 41 (Workstation Edition)"\nID=fedora\n',
  rocky: 'PRETTY_NAME="Rocky Linux 9"\nID="rocky"\nID_LIKE="rhel centos fedora"\n',
  arch: 'PRETTY_NAME="Arch Linux"\nID=arch\n',
  manjaro: 'PRETTY_NAME="Manjaro Linux"\nID=manjaro\nID_LIKE=arch\n',
  alpine: 'PRETTY_NAME="Alpine Linux v3.20"\nID=alpine\n',
  opensuse: 'PRETTY_NAME="openSUSE Tumbleweed"\nID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n',
} as const;

/**
 * A sandbox for install.sh: temp HOME, fake uname (arch), fake os-release and meminfo,
 * and fake privileged commands so even a mistake can't change the machine.
 */
export function installSandbox(o: { os: string; arch?: string; ramMb?: number }) {
  const dir = tempDir("inst");
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  fakeBin(bin, "uname", `case "$1" in -m) echo ${o.arch ?? "x86_64"} ;; -s|"") echo Linux ;; *) /usr/bin/uname "$@" ;; esac`);
  for (const c of ["sudo", "apt-get", "dnf", "pacman", "useradd", "usermod", "userdel", "systemctl", "loginctl"]) {
    fakeBin(bin, c, `echo "FAKE ${c} $*" >> "${dir}/calls"; exit 0`);
  }
  writeFileSync(join(dir, "os-release"), o.os);
  writeFileSync(join(dir, "meminfo"), `MemTotal:       ${(o.ramMb ?? 4096) * 1024} kB\nMemFree:         1000 kB\n`);
  const env = {
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    MORPHIX_OS_RELEASE: join(dir, "os-release"),
    MORPHIX_MEMINFO: join(dir, "meminfo"),
  };
  return { dir, home, bin, env, run: (...args: string[]) => bash([INSTALL_SH, ...args], env) };
}

/** Sources the CLI (no main) and runs a snippet with its functions. */
export function cli(snippet: string, env: Record<string, string> = {}): Run {
  return bash(["-c", `set -euo pipefail; source "${CLI}"; ${snippet}`], {
    PATH: process.env.PATH ?? "",
    HOME: env.HOME ?? tempDir("clihome"),
    MORPHIX_CLI_SOURCE_ONLY: "1",
    ...env,
  });
}
