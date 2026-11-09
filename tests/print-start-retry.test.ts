// The QD330 sometimes drops the connection right after an upload ("printer closed the
// connection" before M23 was sent). Starting retries only while nothing reached the printer.
import { describe, expect, it } from "vitest";
import { Printing } from "../apps/desktop/electron/printing";

function withController(results: { sent: boolean; confirmed: boolean; error?: string }[]) {
  const p: any = Object.create(Printing.prototype);
  const calls: unknown[] = [];
  p.ctx = { log: { write: () => {} } };
  p.controller = { startPrint: async (o: unknown) => (calls.push(o), { op: "start", acknowledged: false, protocolVerified: true, ...results[Math.min(calls.length - 1, results.length - 1)] }) };
  return { p, calls };
}

describe("starting a print after an upload", () => {
  it("retries when the printer dropped the connection before M23 was sent", async () => {
    const { p, calls } = withController([{ sent: false, confirmed: false, error: "printer closed the connection" }, { sent: true, confirmed: true }]);
    const r = await p.startAfterUpload({ jobId: "j", fileName: "a.gx", authorization: undefined }, [1, 1, 1]);
    expect(r.confirmed).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("never retries once M23 was sent (no double start)", async () => {
    const { p, calls } = withController([{ sent: true, confirmed: false, error: "print start not confirmed" }]);
    const r = await p.startAfterUpload({ jobId: "j", fileName: "a.gx", authorization: undefined }, [1, 1, 1]);
    expect(r.confirmed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("gives up after the last wait", async () => {
    const { p, calls } = withController([{ sent: false, confirmed: false }]);
    await p.startAfterUpload({ jobId: "j", fileName: "a.gx", authorization: undefined }, [1, 1]);
    expect(calls).toHaveLength(3);
  });
});
