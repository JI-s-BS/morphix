import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildWorkerArgs, VisionWorker } from "@morphix/guardian";
import type { VisionEvent, WorkerStatus } from "@morphix/guardian";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = Math.floor(Math.random() * 10000);
  written: string[] = [];
  killed: string[] = [];
  constructor() {
    super();
    this.stdin.on("data", (c) => this.written.push(String(c)));
  }
  kill(sig: string) {
    this.killed.push(sig);
    setImmediate(() => this.emit("exit", null, sig));
    return true;
  }
  crash(code = 1) {
    this.emit("exit", code, null);
  }
}

const tick = () => new Promise((r) => setImmediate(r));
const line = (o: object) => JSON.stringify({ v: 1, seq: 1, ts: "t", session: "s", ...o }) + "\n";

function setup(config: Partial<ConstructorParameters<typeof VisionWorker>[0]> = {}) {
  const children: FakeChild[] = [];
  const spawns: { cmd: string; args: string[]; cwd?: string }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let now = 0;
  const events: VisionEvent[] = [];
  const statuses: WorkerStatus[] = [];
  const logs: string[] = [];
  const w = new VisionWorker(
    { cwd: "/opt/vision", pythonPath: "/usr/bin/python3", ...config },
    { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s), onLog: (l, s) => logs.push(`${s}:${l}`) },
    {
      spawn: (cmd, args, opts) => {
        spawns.push({ cmd, args, cwd: opts.cwd as string });
        const c = new FakeChild();
        children.push(c);
        return c as unknown as ChildProcess;
      },
      now: () => now,
      setTimeout: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
      clearTimeout: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
    },
  );
  const runTimer = () => timers.shift()!.fn();
  return { w, children, spawns, timers, events, statuses, logs, runTimer, advance: (ms: number) => (now += ms) };
}

describe("vision worker process wrapper", () => {
  it("builds python arguments", () => {
    expect(buildWorkerArgs({ cwd: "x", snapshotUrl: "http://cam/?action=snapshot", intervalSeconds: 10, evidenceDir: "/m/snapshots/s1", session: "s1", roi: "0.1,0.1,0.8,0.8", confirm: "3/5", stallSeconds: 300, extraArgs: ["--heartbeat", "30"] }))
      .toEqual(["-m", "morphix_vision", "--exit-on-stdin-eof", "--snapshot-url", "http://cam/?action=snapshot", "--interval", "10", "--evidence-dir", "/m/snapshots/s1", "--session", "s1", "--roi", "0.1,0.1,0.8,0.8", "--confirm", "3/5", "--stall-seconds", "300", "--heartbeat", "30"]);
    expect(buildWorkerArgs({ cwd: "x", args: ["custom.py"] })).toEqual(["custom.py"]);
  });

  it("parses split JSON lines, routes junk and stderr to the log", async () => {
    const { w, children, spawns, events, logs } = setup();
    w.start();
    expect(spawns[0]).toMatchObject({ cmd: "/usr/bin/python3", cwd: "/opt/vision" });
    const c = children[0];
    const l = line({ type: "camera_ok", width: 1280, height: 720, recovered_from: null });
    c.stdout.write(l.slice(0, 10));
    c.stdout.write(l.slice(10) + "Traceback: oops\n" + line({ type: "warning", detail: "w" }));
    c.stderr.write("cv2 warning\n");
    await tick();
    expect(events.map((e) => e.type)).toEqual(["camera_ok", "warning"]);
    expect(logs).toEqual(["stdout:Traceback: oops", "stderr:cv2 warning"]);
  });

  it("forwards printer state and replays it to a restarted worker", async () => {
    const { w, children, runTimer } = setup();
    w.sendPrinterState({ online: true, machine: "READY" }); // before start: queued
    w.start();
    await tick();
    expect(children[0].written.join("")).toContain('"machine":"READY"');
    w.sendPrinterState({ online: true, machine: "BUILDING_FROM_SD", progress: 5 });
    w.resetBaseline();
    await tick();
    const sent = children[0].written.join("").trim().split("\n").map((s) => JSON.parse(s));
    expect(sent.map((m) => m.type)).toEqual(["printer_state", "printer_state", "reset_baseline"]);
    children[0].crash();
    runTimer();
    await tick();
    expect(children[1].written.join("")).toContain("BUILDING_FROM_SD");
  });

  it("restarts with exponential backoff, resets after a stable run, and can give up", () => {
    const { w, children, timers, statuses, runTimer, advance } = setup({ restartBaseMs: 1000, restartMaxMs: 8000, stableAfterMs: 60_000, maxRestarts: 6 });
    w.start();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      children.at(-1)!.crash();
      delays.push(timers[0].ms);
      runTimer();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000]);
    advance(120_000); // a long healthy run resets the backoff
    children.at(-1)!.crash();
    expect(timers[0].ms).toBe(1000);
    expect(statuses.at(-1)).toMatchObject({ state: "restarting", attempt: 1, lastExit: { code: 1 } });

    const quick = setup({ maxRestarts: 1 });
    quick.w.start();
    quick.children[0].crash(2);
    quick.runTimer();
    quick.children[1].crash(2);
    expect(quick.statuses.at(-1)).toMatchObject({ state: "failed", attempts: 1 });
    expect(quick.w.running).toBe(false);
  });

  it("treats spawn errors (e.g. python missing) as crashes", () => {
    const { w, children, statuses } = setup();
    w.start();
    children[0].emit("error", new Error("spawn python3 ENOENT"));
    children[0].emit("exit", -2, null); // must not double count
    expect(statuses.filter((s) => s.state === "restarting")).toHaveLength(1);
    expect(statuses.at(-1)).toMatchObject({ lastExit: { error: "spawn python3 ENOENT" } });
  });

  it("stop() sends shutdown, SIGTERM and does not restart", async () => {
    const { w, children, timers, statuses } = setup();
    w.start();
    await w.stop();
    expect(children[0].written.join("")).toContain('"type":"shutdown"');
    expect(children[0].killed).toEqual(["SIGTERM"]);
    expect(timers).toHaveLength(0);
    expect(statuses.at(-1)).toEqual({ state: "stopped" });
    expect(children).toHaveLength(1);
  });

  it("supervises a real child process", async () => {
    // Node stands in for Python: prints protocol lines, echoes stdin, then crashes once.
    const script = `
      const fs = require("fs");
      const marker = process.env.MARKER;
      const first = !fs.existsSync(marker);
      const out = (o) => process.stdout.write(JSON.stringify({ v: 1, seq: 1, ts: "t", session: "real", ...o }) + "\\n");
      out({ type: "started", pid: process.pid, snapshot_url: "x", interval: 1, evidence_dir: null, roi: [0,0,1,1], confirm: { n: 3, m: 5 } });
      if (first) { fs.writeFileSync(marker, "1"); process.exit(3); }
      process.stdin.on("data", (d) => out({ type: "warning", detail: "echo " + String(d).trim() }));
      process.stdin.on("end", () => process.exit(0));
    `;
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const marker = join(mkdtempSync(join(tmpdir(), "guardian-")), "crashed");
    const events: VisionEvent[] = [];
    const statuses: WorkerStatus[] = [];
    const w = new VisionWorker(
      { cwd: process.cwd(), pythonPath: process.execPath, args: ["-e", script], env: { MARKER: marker }, restartBaseMs: 20 },
      { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) },
    );
    w.start();
    const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); };
    await until(() => events.filter((e) => e.type === "started").length >= 2);
    w.sendPrinterState({ online: true, machine: "PAUSED" });
    await until(() => events.some((e) => e.type === "warning" && e.detail.includes("PAUSED")));
    await w.stop();
    expect(statuses.some((s) => s.state === "restarting" && s.lastExit.code === 3)).toBe(true);
    expect(events.some((e) => e.type === "warning" && e.detail.includes('"machine":"PAUSED"'))).toBe(true);
    expect(w.status).toEqual({ state: "stopped" });
  }, 10_000);
});
