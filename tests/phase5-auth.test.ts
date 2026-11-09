import { describe, expect, it } from "vitest";
import { authorizePrint, defaultPrintAuthorizer, PrintAuthorizationError, PrintAuthorizer, type PrintAuthorization } from "@morphix/printer";

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof PrintAuthorizationError) return e.code;
    throw e;
  }
  return undefined;
}

describe("print authorization tokens", () => {
  it("issues frozen tokens bound to job and file", () => {
    let now = 1000;
    const a = new PrintAuthorizer({ now: () => now });
    const t = a.authorize({ jobId: "job-1", fileName: "cube.gx", approvedBy: "touch", expiresInMs: 5000 });
    expect(t).toMatchObject({ jobId: "job-1", fileName: "cube.gx", approvedBy: "touch", issuedAt: 1000, expiresAt: 6000 });
    expect(Object.isFrozen(t)).toBe(true);
    expect(a.verify(t, { jobId: "job-1", fileName: "cube.gx" }, false)).toEqual(t);
    now = 5999;
    expect(code(() => a.verify(t, { jobId: "job-1", fileName: "cube.gx" }, true))).toBeUndefined();
  });

  it("rejects missing, unknown, tampered, expired, reused and mismatched tokens", () => {
    let now = 0;
    const a = new PrintAuthorizer({ now: () => now });
    const ok = { jobId: "j", fileName: "f.gx" };
    const t = a.authorize({ ...ok, approvedBy: "voice", expiresInMs: 1000 });

    expect(code(() => a.verify(undefined, ok, true))).toBe("missing");
    expect(code(() => a.verify({ ...t, id: "forged" }, ok, true))).toBe("unknown");
    expect(code(() => a.verify({ ...t, expiresAt: t.expiresAt + 1e9 }, ok, true))).toBe("tampered");
    expect(code(() => a.verify(t, { ...ok, jobId: "other" }, true))).toBe("job-mismatch");
    expect(code(() => a.verify(t, { ...ok, fileName: "other.gx" }, true))).toBe("file-mismatch");
    // a token from another authorizer is unknown here
    expect(code(() => new PrintAuthorizer().verify(t, ok, true))).toBe("unknown");

    a.verify(t, ok, true);
    expect(code(() => a.verify(t, ok, true))).toBe("reused");

    const t2 = a.authorize({ ...ok, approvedBy: "touch", expiresInMs: 1000 });
    now = 1000;
    expect(code(() => a.verify(t2, ok, false))).toBe("expired");

    const t3 = a.authorize({ ...ok, approvedBy: "touch" });
    a.revoke(t3);
    expect(code(() => a.verify(t3, ok, false))).toBe("reused");
  });

  it("caps lifetime and validates the request", () => {
    const a = new PrintAuthorizer({ now: () => 0, maxExpiresInMs: 60_000 });
    expect(a.authorize({ jobId: "j", fileName: "f.gx", approvedBy: "touch", expiresInMs: 1e9 }).expiresAt).toBe(60_000);
    expect(() => a.authorize({ jobId: "", fileName: "f.gx", approvedBy: "touch" })).toThrow();
    expect(() => a.authorize({ jobId: "j", fileName: "f.gx", approvedBy: "guardian" as "touch" })).toThrow();
    expect(() => a.authorize({ jobId: "j", fileName: "../f.gx", approvedBy: "touch" })).toThrow();
    expect(() => a.authorize({ jobId: "j", fileName: "f.gx", approvedBy: "touch", expiresInMs: 0 })).toThrow();
  });

  it("authorizePrint() uses the process-wide authorizer", () => {
    const t: PrintAuthorization = authorizePrint({ jobId: "j", fileName: "f.gx", approvedBy: "touch" });
    expect(defaultPrintAuthorizer.verify(t, { jobId: "j", fileName: "f.gx" }, true).id).toBe(t.id);
  });
});
