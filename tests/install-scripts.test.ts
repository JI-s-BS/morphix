// Static checks of the install scripts, systemd units and Docker files (no system changes).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI, INSTALL_SH, KIOSK, ROOT } from "./install-helpers";

const SCRIPTS = [INSTALL_SH, CLI, KIOSK];
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const hasShellcheck = spawnSync("shellcheck", ["--version"]).status === 0;

describe("install scripts", () => {
  it.each(SCRIPTS)("%s parses (bash -n) and is executable", (file) => {
    const r = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(statSync(file).mode & 0o111).not.toBe(0);
    expect(readFileSync(file, "utf8")).toMatch(/^#!\/usr\/bin\/env bash\nset -euo pipefail|^#!\/usr\/bin\/env bash\n(#.*\n)*set -euo pipefail/);
  });

  it.skipIf(!hasShellcheck).each(SCRIPTS)("%s passes shellcheck", (file) => {
    const r = spawnSync("shellcheck", ["-S", "warning", "-s", "bash", file], { encoding: "utf8" });
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });

  it("install.sh is safe to pipe into bash: functions first, main only on the last line", () => {
    const lines = readFileSync(INSTALL_SH, "utf8").trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe('if [[ "${MORPHIX_INSTALL_SOURCE_ONLY:-0}" != 1 ]]; then main "$@"; fi');
    // no other top-level command runs before main (only assignments, functions and comments)
    let depth = 0;
    for (const line of lines.slice(0, -1)) {
      if (depth === 0 && line.trim() && !line.startsWith("#")) {
        expect(line).toMatch(/^(set -euo pipefail|[A-Z_]+=.*|[a-z_]+\(\) \{.*)$/);
      }
      if (/^[a-z_]+\(\) \{/.test(line) && !/\}\s*$/.test(line)) depth++;
      if (line === "}") depth--;
    }
    expect(depth).toBe(0);
  });

  it("the CLI only runs main when not sourced for tests", () => {
    expect(readFileSync(CLI, "utf8").trimEnd().split("\n").pop()).toBe('if [[ "${MORPHIX_CLI_SOURCE_ONLY:-0}" != 1 ]]; then main "$@"; fi');
  });

  it("the old Pi-only scripts are gone", () => {
    expect(existsSync(join(ROOT, "deploy.sh"))).toBe(false);
    expect(existsSync(join(ROOT, "scripts/pi"))).toBe(false);
  });
});

describe("systemd units", () => {
  const system = read("packaging/systemd/morphix.service.in");

  it("the system service is hardened and only writes its data dir", () => {
    for (const k of ["NoNewPrivileges=yes", "ProtectSystem=strict", "PrivateTmp=yes", "ProtectHome=yes", "ReadWritePaths=@DATA_DIR@", "Restart=on-failure", "User=@USER@", "CapabilityBoundingSet="]) {
      expect(system).toContain(k);
    }
    // these would break USB printers and the V8 JIT
    expect(system).not.toMatch(/^PrivateDevices=yes/m);
    expect(system).not.toMatch(/^MemoryDenyWriteExecute=yes/m);
    // groups that don't exist on every distro (uucp, dialout) would stop the service from starting
    expect(system).not.toMatch(/^SupplementaryGroups=/m);
    expect(system).toContain("ExecStart=@NODE@ @APP_ROOT@/current/apps/server/dist/server.cjs");
  });

  it("templates only use placeholders install.sh fills in", () => {
    const known = new Set(["APP_ROOT", "DATA_DIR", "ENV_FILE", "NODE", "USER", "CLI", "SCOPE"]);
    for (const f of readdirSync(join(ROOT, "packaging/systemd")).filter((x) => x.endsWith(".in"))) {
      for (const m of read(`packaging/systemd/${f}`).matchAll(/@([A-Z_]+)@/g)) expect(known.has(m[1])).toBe(true);
    }
  });

  it("the update timer is nightly and its service runs morphix update --auto", () => {
    expect(read("packaging/systemd/morphix-update.timer.in")).toMatch(/OnCalendar=\*-\*-\* 03:30:00/);
    expect(read("packaging/systemd/morphix-update.service.in")).toContain("ExecStart=@CLI@ update --auto");
  });

  it.skipIf(spawnSync("systemd-analyze", ["--version"]).status !== 0)("rendered units pass systemd-analyze verify syntax", () => {
    // render with harmless values; verify only reports syntax problems we care about
    const out = spawnSync("bash", ["-c", `
      set -e; d="$(mktemp -d)"
      for f in morphix.service morphix-update.service morphix-update.timer; do
        src="${ROOT}/packaging/systemd/$f.in"
        sed -e "s|@APP_ROOT@|/opt/morphix|g;s|@DATA_DIR@|/var/lib/morphix|g;s|@ENV_FILE@|/etc/morphix/morphix.env|g;s|@NODE@|/bin/true|g;s|@USER@|root|g;s|@CLI@|/bin/true|g;s|@SCOPE@|system|g" "$src" > "$d/$f"
      done
      systemd-analyze verify "$d/morphix.service" "$d/morphix-update.service" "$d/morphix-update.timer" 2>&1 | grep -Ei "unknown|invalid|failed to parse" || true`], { encoding: "utf8" });
    expect(out.stdout.trim()).toBe("");
  });
});

describe("Docker", () => {
  const dockerfile = read("Dockerfile");
  const compose = read("docker-compose.yml");

  it("runs as a non-root user on node:22-bookworm-slim with a health check", () => {
    expect(dockerfile).toContain("ARG NODE_IMAGE=node:22-bookworm-slim");
    expect(dockerfile).toMatch(/^USER morphix$/m);
    expect(dockerfile).toMatch(/^HEALTHCHECK .*\n.*\/api\/health/m);
    expect(dockerfile).toContain("ARG WITH_PRUSASLICER=0");
    expect(dockerfile).toContain('CMD ["node", "apps/server/dist/server.cjs"]');
  });

  it("compose keeps data in a volume and documents USB devices and host networking", () => {
    expect(compose).toContain("morphix-data:/data");
    expect(compose).toContain('"8080:8080"');
    expect(compose).toMatch(/# devices:\n\s*#\s+- \/dev\/ttyUSB0:\/dev\/ttyUSB0/);
    expect(compose).toMatch(/# network_mode: host/);
  });
});
