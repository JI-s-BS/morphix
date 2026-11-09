import { afterEach, describe, expect, it } from "vitest";
import {
  CORE_ERROR_CODES,
  ERROR_AREAS,
  ERROR_CODE_PATTERN,
  MorphixError,
  errorCodeOwner,
  getErrorEntry,
  isKnownErrorCode,
  isSerializedMorphixError,
  listErrorCodes,
  registerErrorCodes,
  sanitizeContext,
  unregisterErrorCodes,
  userMessage,
} from "@morphix/errors";

afterEach(() => unregisterErrorCodes("packages/photo3d"));

describe("error-code registry", () => {
  it("has well-formed, unique codes with every field filled in", () => {
    const seen = new Set<string>();
    for (const e of CORE_ERROR_CODES) {
      expect(e.code).toMatch(ERROR_CODE_PATTERN);
      expect(e.code.split("-")[1]).toBe(e.area);
      expect(Object.keys(ERROR_AREAS)).toContain(e.area);
      expect(seen.has(e.code)).toBe(false);
      seen.add(e.code);
      expect(e.title.length).toBeGreaterThan(3);
      expect(e.title.length).toBeLessThanOrEqual(60);
      expect(e.title).not.toMatch(/\.$/);
      expect(e.hint).toMatch(/[.!?]$/);
      expect(e.description.length).toBeGreaterThan(10);
      expect(["info", "warning", "error", "critical"]).toContain(e.severity);
      expect(typeof e.retryable).toBe("boolean");
    }
  });

  it("covers every area except the reserved P3D series", () => {
    for (const a of Object.keys(ERROR_AREAS)) {
      if (a === "P3D") expect(listErrorCodes({ area: a })).toHaveLength(0);
      else expect(listErrorCodes({ area: a }).length).toBeGreaterThan(0);
    }
    expect(getErrorEntry("MX-PRINT-001")!.title).toBe("The printer isn't answering");
  });

  it("lets photo3d register its own codes, idempotently", () => {
    const p3d = [{ code: "MX-P3D-001", title: "The photo is too dark", hint: "Turn on a light and take it again.", description: "Mean luminance below threshold.", severity: "warning" as const, retryable: true }];
    registerErrorCodes(p3d, { owner: "packages/photo3d" });
    registerErrorCodes(p3d, { owner: "packages/photo3d" });
    expect(isKnownErrorCode("MX-P3D-001")).toBe(true);
    expect(errorCodeOwner("MX-P3D-001")).toBe("packages/photo3d");
    expect(listErrorCodes({ area: "P3D" })).toHaveLength(1);
    expect(listErrorCodes({ core: true }).some((e) => e.area === "P3D")).toBe(false);
    expect(new MorphixError("MX-P3D-001").title).toBe("The photo is too dark");
    expect(() => registerErrorCodes([{ ...p3d[0], title: "Other" }], { owner: "packages/photo3d" })).toThrow(/already registered/);
    expect(() => registerErrorCodes([{ ...p3d[0] }], { owner: "someone-else" })).toThrow(/already registered/);
  });

  it("rejects core overrides and malformed entries", () => {
    const base = { title: "x x x", hint: "Try.", description: "something long", severity: "error" as const, retryable: false };
    expect(() => registerErrorCodes([{ code: "MX-PRINT-001", ...base }], { owner: "packages/photo3d" })).toThrow(/core/);
    expect(() => registerErrorCodes([{ code: "MX-P3D-1", ...base }], { owner: "packages/photo3d" })).toThrow(/invalid error code/);
    expect(() => registerErrorCodes([{ code: "MX-P3D-002", ...base, severity: "fatal" as never }], { owner: "packages/photo3d" })).toThrow(/severity/);
    expect(() => registerErrorCodes([{ code: "MX-P3D-002", ...base, area: "GEN" }], { owner: "packages/photo3d" })).toThrow(/area/);
    expect(isKnownErrorCode("MX-P3D-002")).toBe(false);
  });
});

describe("MorphixError", () => {
  it("carries code, entry, cause and context", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 192.168.4.2:8899"), { code: "ECONNREFUSED" });
    const e = new MorphixError("MX-PRINT-001", { cause, context: { host: "192.168.4.2" } });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("MorphixError");
    expect(e.code).toBe("MX-PRINT-001");
    expect(e.severity).toBe("error");
    expect(e.retryable).toBe(true);
    expect(e.cause).toBe(cause);
    expect(e.message).toMatch(/TCP connection/);
    expect(userMessage(e)).toBe("The printer isn't answering. Check the printer is switched on and its cable is plugged in.");
  });

  it("round-trips through JSON for IPC/HTTP", () => {
    const cause = Object.assign(new Error("boom"), { code: "ECONNRESET" });
    const e = new MorphixError("MX-PRINT-003", { cause, context: { attempt: 2 }, at: "2026-11-07T10:00:00Z" });
    const wire = JSON.parse(JSON.stringify(e));
    expect(isSerializedMorphixError(wire)).toBe(true);
    expect(wire).toEqual({
      name: "MorphixError",
      code: "MX-PRINT-003",
      area: "PRINT",
      title: "The printer hung up",
      hint: "Try again. If it keeps happening, restart the printer.",
      message: e.message,
      severity: "error",
      retryable: true,
      at: "2026-11-07T10:00:00.000Z",
      context: { attempt: 2 },
      cause: { name: "Error", message: "boom", code: "ECONNRESET" },
    });
    const back = MorphixError.fromJSON(wire);
    expect(back.code).toBe("MX-PRINT-003");
    expect((back.cause as Error & { code: string }).code).toBe("ECONNRESET");
    expect(back.toJSON()).toEqual(wire);
  });

  it("keeps unregistered codes but uses generic text", () => {
    const e = new MorphixError("MX-P3D-099");
    expect(e.code).toBe("MX-P3D-099");
    expect(e.area).toBe("P3D");
    expect(e.title).toBe("Something went wrong");
  });

  it("sanitises context: secrets, buffers, functions, depth", () => {
    const ctx = sanitizeContext({
      apiKey: "sk-123",
      headers: { Authorization: "Bearer abc", "x-goog-api-key": "k" },
      url: "https://x.test/a?key=SECRET&b=1",
      gx: Buffer.alloc(10),
      fn: () => 1,
      nan: NaN,
      deep: { a: { b: { c: { d: { e: 1 } } } } },
      long: "x".repeat(2000),
    });
    expect(ctx.apiKey).toBe("[redacted]");
    expect(ctx.headers).toEqual({ Authorization: "[redacted]", "x-goog-api-key": "[redacted]" });
    expect(ctx.url).toBe("https://x.test/a?key=[redacted]&b=1");
    expect(ctx.gx).toBe("<10 bytes>");
    expect("fn" in ctx).toBe(false);
    expect(ctx.nan).toBe("NaN");
    expect(JSON.stringify(ctx.deep)).toContain("[…]");
    expect((ctx.long as string).length).toBeLessThan(1100);
  });
});
