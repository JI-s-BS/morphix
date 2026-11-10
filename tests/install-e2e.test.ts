// End to end, as a user install: install.sh → morphix update → a broken update rolls back by
// itself → busy marker blocks updates → rollback → backup/restore. The "repo" is a throwaway
// git repo whose build writes a tiny server.cjs; systemctl is faked to run it on a free port.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OS, ROOT, bash, fakeBin, tempDir } from "./install-helpers";

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function writeVersion(repo: string, version: string, healthy: boolean) {
  writeFileSync(
    join(repo, "build-server.js"),
    `const fs = require("fs");
fs.mkdirSync("apps/server/dist", { recursive: true });
fs.writeFileSync("apps/server/dist/server.cjs", ${JSON.stringify(`
if (process.argv[2] === "reset-admin") { console.log("reset-admin for " + process.env.MORPHIX_DATA_DIR); process.exit(0); }
require("http").createServer((q, r) => {
  if (q.url !== "/api/health") { r.writeHead(404); return r.end(); }
  r.writeHead(${healthy ? 200 : 500}, { "content-type": "application/json" });
  r.end(JSON.stringify({ ok: ${healthy}, version: "${version}" }));
}).listen(Number(process.env.MORPHIX_PORT), "127.0.0.1");
`)});
`,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", `version ${version}`);
  return git(repo, "rev-parse", "HEAD");
}

describe("install → update → rollback (user install, fake systemd)", () => {
  const dir = tempDir("e2e");
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  const appRoot = join(home, ".local/share/morphix-app");
  const dataDir = join(home, ".local/share/morphix");
  let port = 0;
  let env: Record<string, string> = {};
  const shas: Record<string, string> = {};
  const morphix = (...args: string[]) => bash([join(home, ".local/bin/morphix"), ...args], env, { timeout: 120_000 });
  const health = () => {
    try {
      return execFileSync("curl", ["-fsS", "--max-time", "3", `http://127.0.0.1:${port}/api/health`], { encoding: "utf8" });
    } catch {
      return "down";
    }
  };
  const current = () => basename(readlinkSync(join(appRoot, "current")));

  beforeAll(async () => {
    port = await freePort();
    mkdirSync(home, { recursive: true });
    mkdirSync(state, { recursive: true });
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    cpSync(join(ROOT, "scripts/install"), join(repo, "scripts/install"), { recursive: true });
    cpSync(join(ROOT, "packaging"), join(repo, "packaging"), { recursive: true });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "fake-morphix", version: "1.0.0", private: true, scripts: { test: "node -e 0", build: "node -e 0", "build:server": "node build-server.js" } }),
    );
    writeFileSync(
      join(repo, "package-lock.json"),
      JSON.stringify({ name: "fake-morphix", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fake-morphix", version: "1.0.0" } } }),
    );
    shas.v1 = writeVersion(repo, "v1", true);
    fakeBin(
      bin,
      "systemctl",
      `[[ "$1" == --user ]] && shift
echo "$*" >> "${state}/calls"
pidf="${state}/pid"
stop() { [[ -f "$pidf" ]] && kill "$(cat "$pidf")" 2>/dev/null; rm -f "$pidf"; sleep 0.3; }
case "$1" in
  # a simple command in the background, so $! is node itself (not a subshell holding our stdout)
  restart|start) stop; cd "${appRoot}/current"; MORPHIX_PORT=${port} MORPHIX_DATA_DIR="${dataDir}" nohup node "${appRoot}/current/apps/server/dist/server.cjs" </dev/null >>"${state}/server.log" 2>&1 & echo $! > "$pidf" ;;
  stop) stop ;;
  is-active) if [[ -f "$pidf" ]] && kill -0 "$(cat "$pidf")" 2>/dev/null; then echo active; else echo inactive; exit 3; fi ;;
  is-enabled) echo disabled; exit 1 ;;
esac
exit 0`,
    );
    fakeBin(bin, "loginctl", 'echo yes');
    writeFileSync(join(dir, "os-release"), OS.debian);
    env = {
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      MORPHIX_OS_RELEASE: join(dir, "os-release"),
      MORPHIX_ASSUME_SYSTEMD: "1",
      MORPHIX_HEALTH_TIMEOUT: "6",
      MORPHIX_HEALTH_INTERVAL: "0.3",
      MORPHIX_BUSY_POLL: "0.2",
    };
  }, 30_000);

  afterAll(() => {
    bash(["-c", `[[ -f "${state}/pid" ]] && kill "$(cat "${state}/pid")" 2>/dev/null; true`], env);
  });

  it("install.sh installs, builds and starts it, and prints the LAN URL", () => {
    const r = bash([join(ROOT, "scripts/install/install.sh"), "--user", "--repo", repo, "--channel", "main", "--port", String(port)], env, { timeout: 180_000 });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("Health check passed");
    expect(r.out).toContain(`:${port}`);
    expect(current()).toBe(shas.v1);
    expect(health()).toContain('"version":"v1"');
    expect(existsSync(join(home, ".config/systemd/user/morphix.service"))).toBe(true);
    const unit = readFileSync(join(home, ".config/systemd/user/morphix.service"), "utf8");
    expect(unit).toContain(`MORPHIX_DATA_DIR=${dataDir}`);
    expect(unit).not.toMatch(/@[A-Z_]+@/);
    expect((execFileSync("stat", ["-c", "%a", dataDir], { encoding: "utf8" }) as string).trim()).toBe("700");
    // re-running is harmless
    const again = bash([join(ROOT, "scripts/install/install.sh"), "--user", "--repo", repo], env, { timeout: 120_000 });
    expect(again.status, again.out).toBe(0);
    expect(again.out).toContain("Already up to date");
    expect(readFileSync(join(home, ".config/morphix/install.conf"), "utf8")).toContain("CHANNEL=main");
  }, 240_000);

  it("morphix update builds the new version in its own release dir and switches", () => {
    shas.v2 = writeVersion(repo, "v2", true);
    const r = morphix("update", "--skip-tests");
    expect(r.status, r.out).toBe(0);
    expect(current()).toBe(shas.v2);
    expect(readlinkSync(join(appRoot, "previous"))).toBe(`releases/${shas.v1}`);
    expect(health()).toContain('"version":"v2"');
  }, 120_000);

  it("a release that fails its health check is rolled back automatically, and not retried", () => {
    shas.v3 = writeVersion(repo, "v3", false);
    const r = morphix("update");
    expect(r.status).toBe(1);
    expect(r.out).toContain("did not pass the health check; rolling back");
    expect(current()).toBe(shas.v2);
    expect(health()).toContain('"version":"v2"');
    expect(existsSync(join(appRoot, "releases", shas.v3, ".failed-health"))).toBe(true);
    const again = morphix("update");
    expect(again.status).toBe(0);
    expect(again.out).toContain("failed its health check before");
  }, 120_000);

  it("never restarts while busy: manual update gives up, the nightly one skips", () => {
    shas.v4 = writeVersion(repo, "v4", true);
    mkdirSync(join(dataDir, "run"), { recursive: true });
    writeFileSync(join(dataDir, "run", "printing"), "Ender 3: 37%\n");
    const manual = morphix("update", "--wait", "0", "--skip-tests");
    expect(manual.status).toBe(1);
    expect(manual.out).toContain("still busy (printing: Ender 3: 37%");
    writeFileSync(join(dataDir, "run", "printing"), "Ender 3: 38%\n");
    const nightly = morphix("update", "--auto", "--wait", "0");
    expect(nightly.status).toBe(0);
    expect(nightly.out).toContain("skipping this automatic update");
    expect(current()).toBe(shas.v2);
    execFileSync("rm", ["-f", join(dataDir, "run", "printing")]);
    const done = morphix("update", "--skip-tests");
    expect(done.status, done.out).toBe(0);
    expect(current()).toBe(shas.v4);
  }, 120_000);

  it("morphix rollback goes back to the previous release", () => {
    const r = morphix("rollback");
    expect(r.status, r.out).toBe(0);
    expect(current()).toBe(shas.v2);
    expect(health()).toContain('"version":"v2"');
  }, 60_000);

  it("status, version, doctor, reset-admin", () => {
    expect(morphix("status").out).toMatch(/service: +active[\s\S]*health: +ok/);
    expect(morphix("version").out).toContain(`release ${shas.v2}`);
    const doc = morphix("doctor");
    expect(doc.out).toContain("[ok]   health endpoint answers");
    expect(doc.out).toContain(`[ok]   data dir ${dataDir} (700`);
    expect(morphix("reset-admin").out).toContain(`reset-admin for ${dataDir}`);
  }, 60_000);

  it("backup leaves secrets out unless asked; restore puts the data back", () => {
    writeFileSync(join(dataDir, "secrets.json"), '{"GEMINI_API_KEY":"x"}');
    mkdirSync(join(dataDir, "models"), { recursive: true });
    writeFileSync(join(dataDir, "models", "cube.stl"), "solid cube");
    const out = join(dir, "b.tgz");
    const b = morphix("backup", "-o", out);
    expect(b.status, b.out).toBe(0);
    const list = execFileSync("tar", ["-tzf", out], { encoding: "utf8" });
    expect(list).toContain("./models/cube.stl");
    expect(list).not.toContain("secrets.json");
    expect((execFileSync("stat", ["-c", "%a", out], { encoding: "utf8" }) as string).trim()).toBe("600");
    const withSecrets = join(dir, "s.tgz");
    expect(morphix("backup", "-o", withSecrets, "--include-secrets").out).toContain("CONTAINS SECRETS");
    expect(execFileSync("tar", ["-tzf", withSecrets], { encoding: "utf8" })).toContain("secrets.json");
    writeFileSync(join(dataDir, "models", "cube.stl"), "changed");
    const r = morphix("restore", out, "--yes");
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(dataDir, "models", "cube.stl"), "utf8")).toBe("solid cube");
    expect(health()).toContain('"ok":true');
  }, 60_000);

  it("uninstall keeps the data", () => {
    const r = bash([join(ROOT, "scripts/install/install.sh"), "--uninstall", "--user", "--yes"], { ...env, MORPHIX_OS_RELEASE: join(dir, "os-release") }, { timeout: 60_000 });
    expect(r.status, r.out).toBe(0);
    expect(existsSync(appRoot)).toBe(false);
    expect(existsSync(join(home, ".local/bin/morphix"))).toBe(false);
    expect(existsSync(join(dataDir, "models", "cube.stl"))).toBe(true);
  }, 60_000);
});
