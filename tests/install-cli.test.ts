// The morphix CLI's decision logic, sourced as functions (MORPHIX_CLI_SOURCE_ONLY=1).
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI, bash, cli, tempDir } from "./install-helpers";

describe("morphix update arguments", () => {
  const parse = (args: string) => cli(`parse_update_args ${args}; echo "ch=$UPD_CHANNEL skip=$UPD_SKIP_TESTS force=$UPD_FORCE wait=$UPD_WAIT_MIN auto=$UPD_AUTO"`);

  it("defaults", () => expect(parse("").stdout.trim()).toBe("ch= skip=0 force=0 wait=60 auto=0"));
  it("all options", () =>
    expect(parse("--channel main --skip-tests --force --wait 5 --auto").stdout.trim()).toBe("ch=main skip=1 force=1 wait=5 auto=1"));
  it("--channel=stable", () => expect(parse("--channel=stable").stdout).toContain("ch=stable"));
  it.each(["--channel beta", "--channel", "--wait soon", "--nope"])("rejects %s", (args) => {
    const r = cli(`parse_update_args ${args} && echo parsed || echo "rc=$?"`);
    expect(r.stdout.trim()).toBe("rc=2");
  });
});

describe("other arguments", () => {
  it("logs -f -n 50", () => expect(cli('parse_logs_args -f -n 50; echo "$LOGS_FOLLOW $LOGS_LINES"').stdout.trim()).toBe("1 50"));
  it("logs default", () => expect(cli('parse_logs_args; echo "$LOGS_FOLLOW $LOGS_LINES"').stdout.trim()).toBe("0 100"));
  it("backup keeps secrets out unless asked", () => {
    expect(cli('parse_backup_args; echo "[$BK_OUT] $BK_SECRETS"').stdout.trim()).toBe("[] 0");
    expect(cli('parse_backup_args -o /tmp/b.tgz --include-secrets; echo "[$BK_OUT] $BK_SECRETS"').stdout.trim()).toBe("[/tmp/b.tgz] 1");
  });
  it("restore needs exactly one file", () => {
    expect(cli('parse_restore_args b.tgz --yes; echo "$RS_FILE $RS_YES"').stdout.trim()).toBe("b.tgz 1");
    expect(cli("parse_restore_args && echo ok || echo bad").stdout.trim()).toBe("bad");
    expect(cli("parse_restore_args a b && echo ok || echo bad").stdout.trim()).toBe("bad");
  });
  it("usage and unknown commands", () => {
    expect(bash([CLI, "--help"], { PATH: process.env.PATH ?? "" }).stdout).toContain("rollback [RELEASE]");
    const conf = join(tempDir("conf"), "install.conf");
    writeFileSync(conf, `MODE=user\nAPP_ROOT=/nonexistent\nDATA_DIR=/nonexistent-data\n`);
    expect(bash([CLI, "frobnicate"], { PATH: process.env.PATH ?? "", MORPHIX_INSTALL_CONF: conf }).status).toBe(2);
  });
  it("says how to install when there is no install", () => {
    const r = bash([CLI, "status"], { PATH: process.env.PATH ?? "", MORPHIX_INSTALL_CONF: "/nonexistent/install.conf" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Morphix is not installed here");
  });
  it("parses install.conf without running it", () => {
    const dir = tempDir("conf");
    const conf = join(dir, "install.conf");
    writeFileSync(conf, `# c\nMODE=user\nAPP_ROOT=/a\nDATA_DIR=/d\nPORT=9090\nEVIL=$(touch ${dir}/pwned)\nCHANNEL=main\n`);
    const r = cli('load_conf; echo "$MODE $APP_ROOT $DATA_DIR $PORT $CHANNEL"; ls "$(dirname "$MORPHIX_INSTALL_CONF")"', { MORPHIX_INSTALL_CONF: conf });
    expect(r.stdout).toContain("user /a /d 9090 main");
    expect(r.stdout).not.toContain("pwned");
  });
});

describe("busy marker", () => {
  const now = Math.floor(Date.now() / 1000);
  const marker = (name: string, ageS: number, text = "Bottle: slice") => {
    const d = tempDir("busy");
    mkdirSync(join(d, "run"));
    writeFileSync(join(d, "run", name), `${text}\n`);
    const t = now - ageS;
    utimesSync(join(d, "run", name), t, t);
    return d;
  };

  it("fresh busy file = busy, with the reason", () => {
    const r = cli(`busy_reason "${marker("busy", 2)}" ${now} && echo BUSY`);
    expect(r.stdout).toContain("busy: Bottle: slice");
    expect(r.stdout).toContain("BUSY");
  });
  it("a fresh printing marker counts too (a USB print would be cut off by a restart)", () => {
    expect(cli(`busy_reason "${marker("printing", 5, "Ender 3: 42%")}" ${now} && echo BUSY`).stdout).toContain("printing: Ender 3: 42%");
  });
  it("stale (> 30 s, the app isn't running) or missing = not busy", () => {
    expect(cli(`busy_reason "${marker("busy", 120)}" ${now} && echo BUSY || echo IDLE`).stdout.trim()).toBe("IDLE");
    expect(cli(`busy_reason "${tempDir("nobusy")}" ${now} && echo BUSY || echo IDLE`).stdout.trim()).toBe("IDLE");
  });
});

describe("rollback decisions", () => {
  it("after the health check: keep, roll back, or report broken", () => {
    expect(cli("decide_after_health 1 abc").stdout.trim()).toBe("keep");
    expect(cli("decide_after_health 1 ''").stdout.trim()).toBe("keep");
    expect(cli("decide_after_health 0 abc").stdout.trim()).toBe("rollback");
    expect(cli("decide_after_health 0 ''").stdout.trim()).toBe("broken");
  });

  it("rollback target: requested (prefix ok), else previous, else newest other", () => {
    expect(cli("rollback_target c3 b2 '' c3 b2 a1").stdout.trim()).toBe("b2");
    expect(cli("rollback_target c3 '' '' c3 b2 a1").stdout.trim()).toBe("b2");
    expect(cli("rollback_target c3 b2 a c3 b2 a1").stdout.trim()).toBe("a1");
    expect(cli("rollback_target c3 c3 '' c3 a1").stdout.trim()).toBe("a1");
    expect(cli("rollback_target c3 '' '' c3 || echo none").stdout.trim()).toBe("none");
    expect(cli("rollback_target c3 '' zz c3 b2 || echo none").stdout.trim()).toBe("none");
  });

  it("prunes old releases but never current or previous", () => {
    expect(cli("prune_list 3 r5 r1 r5 r4 r3 r2 r1").stdout.trim().split("\n")).toEqual(["r2"]);
    // after a rollback current is older than the newest releases: it stays anyway
    expect(cli("prune_list 2 r2 '' r4 r3 r2 r1").stdout.trim().split("\n")).toEqual(["r1"]);
    expect(cli("prune_list 3 r1 r2 r1 r2").stdout.trim()).toBe("");
  });

  it("Node version check", () => {
    expect(cli("node_major_ok v22.11.0 22 && echo y").stdout.trim()).toBe("y");
    expect(cli("node_major_ok v24.1.0 22 && echo y").stdout.trim()).toBe("y");
    expect(cli("node_major_ok v20.18.0 22 && echo y || echo n").stdout.trim()).toBe("n");
    expect(cli("node_major_ok garbage 22 && echo y || echo n").stdout.trim()).toBe("n");
  });

  it("refuses restore archives with unsafe paths", () => {
    const d = tempDir("tar");
    const r = bash(["-c", `
      set -e; cd "${d}"; mkdir -p ok/x; echo hi > ok/x/f
      tar -czf good.tgz -C ok .
      tar -czf bad.tgz -P --transform 's|^|../|' -C ok x
      source "${CLI}"
      tar_is_safe good.tgz && echo good-safe
      tar_is_safe bad.tgz || echo bad-refused`], { PATH: process.env.PATH ?? "", HOME: d, MORPHIX_CLI_SOURCE_ONLY: "1" });
    expect(r.stdout).toContain("good-safe");
    expect(r.stdout).toContain("bad-refused");
  });
});
