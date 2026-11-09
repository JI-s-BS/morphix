import { describe, expect, it } from "vitest";
import {
  ControllerDisabledError,
  detectActivePrint,
  JobTracker,
  InvalidFileNameError,
  PrintAuthorizationError,
  PrinterObserver,
  QD330Controller,
  type UploadProgress,
} from "@morphix/printer";
import { GX, guardLoopbackOnly, startRig, useCleanup } from "./phase5-helpers";

guardLoopbackOnly();
const cleanup = useCleanup();

const CONTROL_VERBS = ["M28", "M29", "M23", "M24", "M25", "M26"];
const controlSent = (received: string[]) => received.filter((c) => CONTROL_VERBS.includes(c.split(" ")[0]));

describe("QD330Controller: disabled by default", () => {
  it("requires an explicit enabled flag", () => {
    expect(() => new QD330Controller({ host: "127.0.0.1" } as never)).toThrow(/enabled/);
  });

  it("throws on every control method when disabled and never touches the printer", async () => {
    const rig = await startRig({}, cleanup);
    const c = rig.controller({ enabled: false });
    const token = rig.auth.authorize({ jobId: "j", fileName: "Afinia_Cube.gx", approvedBy: "touch" });
    await expect(c.listFiles()).rejects.toThrow(ControllerDisabledError);
    await expect(c.uploadFile("x.gx", GX, { jobId: "j", authorization: token })).rejects.toThrow(ControllerDisabledError);
    await expect(c.startPrint({ jobId: "j", fileName: "Afinia_Cube.gx", authorization: token })).rejects.toThrow(ControllerDisabledError);
    await expect(c.pause({ requestedBy: "voice" })).rejects.toThrow(ControllerDisabledError);
    await expect(c.resume({ jobId: "j", fileName: "Afinia_Cube.gx", authorization: token })).rejects.toThrow(ControllerDisabledError);
    await expect(c.cancel({ requestedBy: "touch" })).rejects.toThrow(ControllerDisabledError);
    expect(rig.fake.received).toEqual([]);
    expect(rig.log.map((e) => e.outcome)).toEqual(Array(6).fill("rejected"));
    // read-only status still works while disabled
    expect((await c.readStatus()).machine).toBe("READY");
    expect(controlSent(rig.fake.received)).toEqual([]);
  });
});

describe("QD330Controller: files and upload", () => {
  it("lists stored files from the binary M661 reply", async () => {
    const rig = await startRig({ files: { "Afinia_Cube.gx": GX, "dance.g": GX } }, cleanup);
    const r = await rig.controller().listFiles();
    expect(r).toMatchObject({ sent: true, acknowledged: true, confirmed: true });
    expect(r.data).toEqual([
      { name: "Afinia_Cube.gx", path: "/data/Afinia_Cube.gx" },
      { name: "dance.g", path: "/data/dance.g" },
    ]);
    expect(rig.fake.received[0]).toBe("M601 S1");
    expect(rig.fake.received.at(-1)).toBe("M602");
  });

  it("lists files when the printer sends no ok after the binary list", async () => {
    const rig = await startRig({ m661Ok: false }, cleanup);
    const r = await rig.controller().listFiles();
    expect(r.data?.map((f) => f.name)).toEqual(["Afinia_Cube.gx"]);
  });

  it("uploads a multi-chunk .gx as raw bytes (stored byte-for-byte), reports progress, and confirms via M661", async () => {
    const rig = await startRig({}, cleanup);
    const data = Buffer.alloc(4096 * 2 + 100);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
    const name = "Robot Arm.gx";
    const token = rig.auth.authorize({ jobId: "job-7", fileName: "Robot_Arm.gx", approvedBy: "touch" });
    const progress: UploadProgress[] = [];
    const r = await rig.controller().uploadFile(name, data, { jobId: "job-7", authorization: token, onProgress: (p) => progress.push(p) });
    expect(r).toMatchObject({ op: "upload", sent: true, acknowledged: true, confirmed: true, data: { fileName: "Robot_Arm.gx", bytes: data.length, packets: 3 } });
    expect(rig.fake.files.get("Robot_Arm.gx")?.equals(data)).toBe(true);
    expect(rig.fake.received).toContain(`M28 ${data.length} 0:/user/Robot_Arm.gx`);
    expect(progress.map((p) => p.packetsSent)).toEqual([1, 2, 3]);
    expect(progress.at(-1)).toMatchObject({ bytesSent: data.length, percent: 100 });
    // upload does not consume the approval: the same token can start the print
    const s = await rig.controller().startPrint({ jobId: "job-7", fileName: "Robot_Arm.gx", authorization: token });
    expect(s.confirmed).toBe(true);
  });

  it("reports a write error on M29 as a failed, unconfirmed upload", async () => {
    const rig = await startRig({ failures: { corruptUpload: true } }, cleanup);
    const token = rig.auth.authorize({ jobId: "j", fileName: "big.gx", approvedBy: "touch" });
    const r = await rig.controller().uploadFile("big.gx", Buffer.alloc(9000, 1), { jobId: "j", authorization: token });
    expect(r).toMatchObject({ sent: true, acknowledged: false, confirmed: false });
    expect(r.error).toMatch(/did not finish the upload/);
    expect(rig.fake.files.has("big.gx")).toBe(false);
  });

  it("fails the upload when M29 is never answered (the file may be incomplete)", async () => {
    const rig = await startRig({ failures: { silent: ["M29"] } }, cleanup);
    const token = rig.auth.authorize({ jobId: "j", fileName: "quiet.gx", approvedBy: "touch" });
    const r = await rig.controller().uploadFile("quiet.gx", GX, { jobId: "j", authorization: token });
    expect(r).toMatchObject({ sent: true, acknowledged: false, confirmed: false });
    expect(r.error).toMatch(/did not confirm it saved the file/);
  });

  it("reports a rejected M28, a dropped connection mid-upload, and a file that never appears", async () => {
    const rig = await startRig({ failures: { rejectUpload: true } }, cleanup);
    const token = rig.auth.authorize({ jobId: "j", fileName: "a.gx", approvedBy: "touch" });
    const r1 = await rig.controller().uploadFile("a.gx", GX, { jobId: "j", authorization: token });
    expect(r1).toMatchObject({ sent: true, acknowledged: false, confirmed: false });
    expect(r1.error).toMatch(/did not accept the upload/);

    rig.fake.failures = { dropOnPacket: 1 };
    const r2 = await rig.controller().uploadFile("a.gx", Buffer.alloc(9000, 2), { jobId: "j", authorization: token });
    expect(r2).toMatchObject({ sent: true, acknowledged: false, confirmed: false });
    expect(r2.error).toMatch(/closed|connection|reply/);

    rig.fake.failures = { loseUploadedFile: true };
    const r3 = await rig.controller().uploadFile("a.gx", GX, { jobId: "j", authorization: token });
    expect(r3).toMatchObject({ sent: true, acknowledged: true, confirmed: false });
    expect(r3.error).toMatch(/not in the printer's file list/);
  });

  it("refuses bad names, empty data, existing files, busy printers and missing approval", async () => {
    const rig = await startRig({}, cleanup);
    const c = rig.controller();
    const t = rig.auth.authorize({ jobId: "j", fileName: "Afinia_Cube.gx", approvedBy: "touch" });
    await expect(c.uploadFile("model.stl", GX, { jobId: "j", authorization: t })).rejects.toThrow(InvalidFileNameError);
    await expect(c.uploadFile("dance.g", GX, { jobId: "j", authorization: t })).rejects.toThrow(InvalidFileNameError);
    await expect(c.uploadFile("Afinia_Cube.gx", Buffer.alloc(0), { jobId: "j", authorization: t })).rejects.toThrow(/empty/);
    await expect(c.uploadFile("Afinia_Cube.gx", GX, { jobId: "j", authorization: undefined })).rejects.toThrow(PrintAuthorizationError);
    await expect(c.uploadFile("other.gx", GX, { jobId: "j", authorization: t })).rejects.toThrow(/file-mismatch|authorization is for/);
    const exists = await c.uploadFile("Afinia_Cube.gx", GX, { jobId: "j", authorization: t });
    expect(exists).toMatchObject({ sent: false, confirmed: false });
    expect(exists.error).toMatch(/already exists/);
    expect(controlSent(rig.fake.received)).toEqual([]);

    rig.fake.machineStatus = "BUILDING_FROM_SD";
    const busy = await c.uploadFile("Afinia_Cube.gx", GX, { jobId: "j", authorization: t, overwrite: true });
    expect(busy).toMatchObject({ sent: false, confirmed: false });
    expect(busy.error).toMatch(/only allowed when READY/);
    expect(controlSent(rig.fake.received)).toEqual([]);
  });

  it("accepts plain .g only behind allowPlainGcode", async () => {
    const rig = await startRig({}, cleanup);
    const t = rig.auth.authorize({ jobId: "j", fileName: "dance.g", approvedBy: "touch" });
    const r = await rig.controller({ allowPlainGcode: true }).uploadFile("dance.g", GX, { jobId: "j", authorization: t });
    expect(r.confirmed).toBe(true);
  });
});

describe("QD330Controller: start, pause, resume, cancel", () => {
  it("starts an existing file only with a valid token and confirms BUILDING_FROM_SD + CurrentFile", async () => {
    const rig = await startRig({ stateChangeDelayMs: 60 }, cleanup);
    const c = rig.controller();
    const t = rig.auth.authorize({ jobId: "job-1", fileName: "Afinia_Cube.gx", approvedBy: "voice" });
    const r = await c.startPrint({ jobId: "job-1", fileName: "Afinia_Cube.gx", authorization: t });
    expect(r).toMatchObject({ op: "start", sent: true, acknowledged: true, confirmed: true, protocolVerified: true });
    expect(r.status).toMatchObject({ machine: "BUILDING_FROM_SD", currentFile: "Afinia_Cube.gx" });
    expect(rig.fake.received).toContain("M23 0:/user/Afinia_Cube.gx");
    expect(rig.log.at(-1)).toMatchObject({ op: "start", outcome: "confirmed", jobId: "job-1", approvedBy: "voice" });
  });

  it("rejects missing, reused, expired and mismatched tokens before sending M23", async () => {
    let now = 0;
    const rig = await startRig({}, cleanup);
    const { PrintAuthorizer } = await import("@morphix/printer");
    const auth = new PrintAuthorizer({ now: () => now });
    const c = rig.controller({ authorizer: auth });
    const file = "Afinia_Cube.gx";
    const codes = async (p: Promise<unknown>) => p.then(() => "none", (e: PrintAuthorizationError) => e.code);

    expect(await codes(c.startPrint({ jobId: "j", fileName: file, authorization: undefined }))).toBe("missing");
    const t = auth.authorize({ jobId: "j", fileName: file, approvedBy: "touch", expiresInMs: 1000 });
    expect(await codes(c.startPrint({ jobId: "other", fileName: file, authorization: t }))).toBe("job-mismatch");
    expect(await codes(c.startPrint({ jobId: "j", fileName: "x.gx", authorization: t }))).toBe("file-mismatch");
    expect(await codes(c.startPrint({ jobId: "j", fileName: file, authorization: rig.auth.authorize({ jobId: "j", fileName: file, approvedBy: "touch" }) }))).toBe("unknown");
    now = 1000;
    expect(await codes(c.startPrint({ jobId: "j", fileName: file, authorization: t }))).toBe("expired");
    expect(controlSent(rig.fake.received)).toEqual([]);

    const t2 = auth.authorize({ jobId: "j", fileName: file, approvedBy: "touch" });
    expect((await c.startPrint({ jobId: "j", fileName: file, authorization: t2 })).confirmed).toBe(true);
    await c.cancel({ requestedBy: "touch" });
    expect(await codes(c.startPrint({ jobId: "j", fileName: file, authorization: t2 }))).toBe("reused");
    expect(rig.log.filter((e) => e.op === "start" && e.outcome === "rejected")).toHaveLength(6);
  });

  it("does not burn the approval when the printer is busy or the file is missing", async () => {
    const rig = await startRig({}, cleanup);
    const c = rig.controller();
    const t = rig.auth.authorize({ jobId: "j", fileName: "Afinia_Cube.gx", approvedBy: "touch" });
    rig.fake.machineStatus = "BUILDING_FROM_SD";
    const busy = await c.startPrint({ jobId: "j", fileName: "Afinia_Cube.gx", authorization: t });
    expect(busy).toMatchObject({ sent: false, confirmed: false });
    expect(busy.error).toMatch(/only start from READY/);
    rig.fake.machineStatus = "READY";
    const missing = rig.auth.authorize({ jobId: "j", fileName: "nope.gx", approvedBy: "touch" });
    const r2 = await c.startPrint({ jobId: "j", fileName: "nope.gx", authorization: missing });
    expect(r2.error).toMatch(/not stored/);
    expect(controlSent(rig.fake.received)).toEqual([]);
    expect((await c.startPrint({ jobId: "j", fileName: "Afinia_Cube.gx", authorization: t })).confirmed).toBe(true);
  });

  it("never reports a start as confirmed when the status does not change", async () => {
    const rig = await startRig({ failures: { ignoreStart: true } }, cleanup);
    const t = rig.auth.authorize({ jobId: "j", fileName: "Afinia_Cube.gx", approvedBy: "touch" });
    const r = await rig.controller().startPrint({ jobId: "j", fileName: "Afinia_Cube.gx", authorization: t });
    expect(r).toMatchObject({ sent: true, acknowledged: true, confirmed: false });
    expect(r.error).toMatch(/did not become BUILDING_FROM_SD/);
    expect(rig.log.at(-1)?.outcome).toBe("unconfirmed");
  });

  it("does not confirm when another file is building", async () => {
    const rig = await startRig({ files: { "Afinia_Cube.gx": GX, "b.gx": GX } }, cleanup);
    const c = rig.controller();
    const t = rig.auth.authorize({ jobId: "j", fileName: "Afinia_Cube.gx", approvedBy: "touch" });
    rig.fake.failures = { ignoreStart: true };
    const p = c.startPrint({ jobId: "j", fileName: "Afinia_Cube.gx", authorization: t });
    setTimeout(() => {
      rig.fake.machineStatus = "BUILDING_FROM_SD";
      rig.fake.currentFile = "b.gx";
    }, 50);
    expect((await p).confirmed).toBe(false);
  });

  it("reports timeouts, dropped connections and refused control without claiming success", async () => {
    const rig = await startRig({ failures: { silent: ["M23"] } }, cleanup);
    const c = rig.controller();
    const tok = () => rig.auth.authorize({ jobId: "j", fileName: "Afinia_Cube.gx", approvedBy: "touch" });
    const timeout = await c.startPrint({ jobId: "j", fileName: "Afinia_Cube.gx", authorization: tok() });
    expect(timeout).toMatchObject({ sent: true, acknowledged: false, confirmed: false });
    expect(timeout.error).toMatch(/no complete reply to M23/);

    rig.fake.failures = { dropOn: ["M26"] };
    const dropped = await c.cancel({ requestedBy: "touch", reason: "test" });
    expect(dropped).toMatchObject({ sent: true, acknowledged: false, confirmed: false });
    expect(dropped.error).toMatch(/closed/);

    rig.fake.failures = { refuseControl: true };
    const refused = await c.cancel({ requestedBy: "touch" });
    expect(refused).toMatchObject({ sent: false, acknowledged: false, confirmed: false });
    expect(refused.error).toMatch(/refused control/);

    await rig.fake.close();
    const offline = await c.cancel({ requestedBy: "touch" });
    expect(offline).toMatchObject({ sent: false, confirmed: false });
    expect(offline.error).toMatch(/cannot reach printer/);
  });

  it("pauses, resumes with a fresh token, and cancels, confirming each from status", async () => {
    const rig = await startRig({ stateChangeDelayMs: 40 }, cleanup);
    const c = rig.controller();
    const file = "Afinia_Cube.gx";
    await c.startPrint({ jobId: "j", fileName: file, authorization: rig.auth.authorize({ jobId: "j", fileName: file, approvedBy: "touch" }) });

    const p = await c.pause({ requestedBy: "guardian", reason: "spaghetti detected" });
    expect(p).toMatchObject({ op: "pause", sent: true, acknowledged: true, confirmed: true, protocolVerified: false });
    expect(p.status?.machine).toBe("PAUSED");
    expect(rig.log.at(-1)).toMatchObject({ op: "pause", requestedBy: "guardian", reason: "spaghetti detected", fileName: file });

    await expect(c.resume({ jobId: "j", fileName: file, authorization: undefined })).rejects.toThrow(PrintAuthorizationError);
    const r = await c.resume({ jobId: "j", fileName: file, authorization: rig.auth.authorize({ jobId: "j", fileName: file, approvedBy: "voice" }) });
    expect(r).toMatchObject({ op: "resume", confirmed: true, protocolVerified: false });

    const x = await c.cancel({ requestedBy: "voice", reason: "user said stop" });
    expect(x).toMatchObject({ op: "cancel", sent: true, acknowledged: true, confirmed: true });
    expect(x.status?.machine).toBe("READY");
    expect(controlSent(rig.fake.received)).toEqual(["M23 0:/user/Afinia_Cube.gx", "M25", "M24", "M26"]);
  });

  it("treats the paused status as unverified: an unexpected value is not confirmed, a configured one is", async () => {
    const rig = await startRig({ pausedStatus: "PAUSE_FROM_SD" }, cleanup);
    const file = "Afinia_Cube.gx";
    const c = rig.controller();
    await c.startPrint({ jobId: "j", fileName: file, authorization: rig.auth.authorize({ jobId: "j", fileName: file, approvedBy: "touch" }) });
    const p = await c.pause({ requestedBy: "touch" });
    expect(p).toMatchObject({ sent: true, acknowledged: true, confirmed: false });
    expect(p.error).toMatch(/PAUSE_FROM_SD/);

    const c2 = rig.controller({ pausedStatuses: ["PAUSED", "PAUSE_FROM_SD"] });
    expect((await c2.pause({ requestedBy: "touch" })).error).toMatch(/already paused/);
    const r = await c2.resume({ jobId: "j", fileName: file, authorization: rig.auth.authorize({ jobId: "j", fileName: file, approvedBy: "touch" }) });
    expect(r.confirmed).toBe(true);
    expect((await c2.pause({ requestedBy: "touch" })).confirmed).toBe(true);
  });

  it("recognises a QD330-style pause (MachineStatus stays BUILDING_FROM_SD, MoveMode PAUSED)", async () => {
    const rig = await startRig({ pauseViaMoveMode: true, stateChangeDelayMs: 30 }, cleanup);
    const file = "Afinia_Cube.gx";
    const c = rig.controller();
    await c.startPrint({ jobId: "j", fileName: file, authorization: rig.auth.authorize({ jobId: "j", fileName: file, approvedBy: "touch" }) });
    const p = await c.pause({ requestedBy: "touch" });
    expect(p).toMatchObject({ acknowledged: true, confirmed: true });
    expect(p.status).toMatchObject({ machine: "BUILDING_FROM_SD", moveMode: "PAUSED" });
    expect((await c.pause({ requestedBy: "touch" })).error).toMatch(/already paused/);

    const tracker = new JobTracker({});
    tracker.update(p.status!);
    expect(tracker.job.phase).toBe("paused");
    expect(detectActivePrint(p.status!)?.paused).toBe(true);

    const r = await c.resume({ jobId: "j", fileName: file, authorization: rig.auth.authorize({ jobId: "j", fileName: file, approvedBy: "touch" }) });
    expect(r.confirmed).toBe(true);
    expect(r.status?.moveMode).not.toBe("PAUSED");
    tracker.update(r.status!);
    expect(tracker.job.phase).toBe("printing");
  });

  it("does not confirm a resume while MoveMode still says PAUSED", async () => {
    const rig = await startRig({ pauseViaMoveMode: true, failures: { ignoreResume: true } }, cleanup);
    const file = "Afinia_Cube.gx";
    const c = rig.controller();
    await c.startPrint({ jobId: "j", fileName: file, authorization: rig.auth.authorize({ jobId: "j", fileName: file, approvedBy: "touch" }) });
    expect((await c.pause({ requestedBy: "touch" })).confirmed).toBe(true);
    const r = await c.resume({ jobId: "j", fileName: file, authorization: rig.auth.authorize({ jobId: "j", fileName: file, approvedBy: "touch" }) });
    expect(r).toMatchObject({ acknowledged: true, confirmed: false });
  });

  it("refuses pause with nothing printing and resume of a different file", async () => {
    const rig = await startRig({ files: { "Afinia_Cube.gx": GX, "b.gx": GX } }, cleanup);
    const c = rig.controller();
    const idle = await c.pause({ requestedBy: "voice" });
    expect(idle).toMatchObject({ sent: false, confirmed: false });
    rig.fake.machineStatus = "PAUSED";
    rig.fake.currentFile = "Afinia_Cube.gx";
    const t = rig.auth.authorize({ jobId: "j", fileName: "b.gx", approvedBy: "touch" });
    const r = await c.resume({ jobId: "j", fileName: "b.gx", authorization: t });
    expect(r).toMatchObject({ sent: false, confirmed: false });
    expect(r.error).toMatch(/paused file is Afinia_Cube.gx/);
    expect(controlSent(rig.fake.received)).toEqual([]);
  });

  it("cancel that the printer ignores is not confirmed", async () => {
    const rig = await startRig({ failures: { ignoreCancel: true } }, cleanup);
    rig.fake.machineStatus = "BUILDING_FROM_SD";
    const r = await rig.controller().cancel({ requestedBy: "touch" });
    expect(r).toMatchObject({ sent: true, acknowledged: true, confirmed: false });
    expect(rig.log.at(-1)).toMatchObject({ op: "cancel", outcome: "unconfirmed", requestedBy: "touch" });
  });

  it("serialises observer polls and control through one queue (no M601 collisions)", async () => {
    const rig = await startRig({ stateChangeDelayMs: 20 }, cleanup);
    const c = rig.controller();
    const seen: string[] = [];
    const observer = new PrinterObserver(c.transport, (s) => seen.push(s.machine ?? (s.error as string)));
    const file = "Afinia_Cube.gx";
    const ops = [
      observer.poll(),
      c.startPrint({ jobId: "j", fileName: file, authorization: rig.auth.authorize({ jobId: "j", fileName: file, approvedBy: "touch" }) }),
      observer.poll(),
      c.listFiles(),
      observer.poll(),
      c.cancel({ requestedBy: "touch" }),
      observer.poll(),
    ];
    const results = await Promise.all(ops);
    expect(rig.fake.controlConflicts).toBe(0);
    expect(seen).toEqual(["READY", "BUILDING_FROM_SD", "BUILDING_FROM_SD", "READY"]);
    expect((results[1] as { confirmed: boolean }).confirmed).toBe(true);
    // every session is opened with M601 S1 and released with M602
    const opens = rig.fake.received.filter((x) => x === "M601 S1").length;
    expect(rig.fake.received.filter((x) => x === "M602").length).toBe(opens);
    await expect(c.transport.query(["G28"])).rejects.toThrow(/not allowed/);
  });

  it("the loopback guard blocks any non-loopback host", () => {
    const c = new QD330Controller({ enabled: true, host: "192.0.2.1", connectTimeoutMs: 10 }); // TEST-NET-1, never routed
    return expect(c.cancel({ requestedBy: "system" })).resolves.toMatchObject({ sent: false, error: expect.stringMatching(/real host/) });
  });
});

describe("QD330Controller: status polls while the printer is busy", () => {
  it("stays online when position/progress replies are slow; only a missing M119 means offline", async () => {
    const rig = await startRig({ failures: { silent: ["M114", "M27"] } }, cleanup);
    const st = await rig.controller().readStatus();
    expect(st).toMatchObject({ online: true, machine: "READY" });
    expect(st.position).toEqual({});
    expect(st.temps?.nozzle).toBeDefined(); // M105 still answered

    rig.fake.failures = { silent: ["M119"] };
    await expect(rig.controller().readStatus()).rejects.toThrow(/M119/);
  });
});
