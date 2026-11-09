// The real QD330 can keep answering "Control failed." with no client connected (seen 2026-11-08
// after a print was stopped). Status polls need M601, so Morphix showed the printer as offline and
// froze the job bar until something sent M602. These tests pin the recovery.
import { describe, expect, it } from "vitest";
import { PrinterObserver } from "@morphix/printer";
import { guardLoopbackOnly, startRig, useCleanup } from "./phase5-helpers";

guardLoopbackOnly();
const cleanup = useCleanup();

describe("stale printer control lock", () => {
  it("a status poll clears a stale lock with M602 and stays online", async () => {
    const rig = await startRig({}, cleanup);
    const c = rig.controller();
    rig.fake.failures = { staleControlLock: true };
    const observer = new PrinterObserver(c.transport, () => undefined);
    const s = await observer.poll();
    expect(s.online).toBe(true);
    expect(s.machine).toBe("READY");
    expect(rig.fake.received.slice(0, 4)).toEqual(["M601 S1", "M602", "M601 S1", "M119"]);
    expect(rig.log.filter((e) => e.op === "recoverControl")).toHaveLength(1);

    // Once cleared, later polls take control normally without the extra release.
    rig.fake.received.length = 0;
    await observer.poll();
    expect(rig.fake.received[0]).toBe("M601 S1");
    expect(rig.fake.received[1]).toBe("M119");
  });

  it("still reports refused control when the printer keeps refusing", async () => {
    const rig = await startRig({}, cleanup);
    const c = rig.controller();
    rig.fake.failures = { refuseControl: true };
    const s = await new PrinterObserver(c.transport, () => undefined).poll();
    expect(s.online).toBe(false);
    expect(s.error).toMatch(/refused control: Control failed/);
    expect(rig.log.some((e) => e.op === "recoverControl")).toBe(false);
  });

  it("never releases a lock while one of Morphix's own sessions is open", async () => {
    const rig = await startRig({}, cleanup);
    const a = rig.controller();
    const b = rig.controller();
    // a's poll holds its session for a reply timeout because the fake never answers M119.
    rig.fake.failures = { silent: ["M119"] };
    const held = a.transport.query(["M119"]).catch(() => undefined);
    // Wait until a really has sent M119 (a fixed 50 ms was too short on the slower Pi).
    for (let t = 0; !rig.fake.received.includes("M119") && t < 3000; t += 10) await new Promise((r) => setTimeout(r, 10));
    expect(rig.fake.received).toContain("M119");
    rig.fake.received.length = 0;
    const s = await new PrinterObserver(b.transport, () => undefined).poll();
    const sentByB = [...rig.fake.received];
    await held;
    expect(s.online).toBe(false);
    expect(sentByB).toEqual(["M601 S1"]);
    expect(rig.fake.controlConflicts).toBeGreaterThan(0);
  });
});
