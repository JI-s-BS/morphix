import { describe, expect, it } from "vitest";
import { MorphixError, toMorphixError, withErrorCode } from "@morphix/errors";

const errno = (code: string, msg = code) => Object.assign(new Error(msg), { code });
const named = (name: string, msg = name) => Object.assign(new Error(msg), { name });
const code = (e: unknown, fallback?: string, service?: Parameters<typeof toMorphixError>[2] extends infer O ? O extends { service?: infer S } ? S : never : never) =>
  toMorphixError(e, fallback, service ? { service } : {}).code;

describe("toMorphixError", () => {
  it("passes MorphixErrors (and their JSON) through", () => {
    const e = new MorphixError("MX-GEN-003");
    expect(toMorphixError(e)).toBe(e);
    expect(toMorphixError(JSON.parse(JSON.stringify(e))).code).toBe("MX-GEN-003");
    expect(toMorphixError(e, "MX-SYS-001", { context: { job: "j1" } }).context).toEqual({ job: "j1" });
  });

  it("routes connection failures by service", () => {
    expect(code(errno("ECONNREFUSED"), "MX-PRINT-008")).toBe("MX-PRINT-001");
    expect(code(errno("EHOSTUNREACH"), "MX-PRINT-008")).toBe("MX-PRINT-001");
    expect(code(errno("ETIMEDOUT"), "MX-PRINT-008")).toBe("MX-PRINT-002");
    expect(code(errno("ECONNRESET"), "MX-PRINT-008")).toBe("MX-PRINT-003");
    expect(code(errno("ECONNREFUSED"))).toBe("MX-NET-001");
    expect(code(errno("ENOTFOUND"))).toBe("MX-NET-002");
    expect(code(errno("ETIMEDOUT"))).toBe("MX-NET-003");
    expect(code(errno("CERT_HAS_EXPIRED"))).toBe("MX-NET-006");
    expect(code(errno("ECONNREFUSED"), undefined, "camera")).toBe("MX-GUARD-001");
    expect(code(errno("ECONNRESET"), undefined, "gemini-live")).toBe("MX-VOICE-002");
    expect(code(errno("ECONNREFUSED"), undefined, "auth0")).toBe("MX-AUTH-005");
  });

  it("unwraps fetch failures (TypeError with errno cause)", () => {
    const e = new TypeError("fetch failed", { cause: errno("ENOTFOUND", "getaddrinfo ENOTFOUND api.meshy.ai") });
    expect(code(e, "MX-GEN-005")).toBe("MX-NET-002");
    expect(code(new TypeError("fetch failed"), "MX-GEN-005")).toBe("MX-NET-001");
    expect(code(new TypeError("fetch failed"), "MX-GEN-010", "gemini")).toBe("MX-GEN-010");
  });

  it("maps Meshy HTTP errors as thrown by @morphix/meshy", () => {
    expect(code(new Error("Meshy 401: Invalid API key"), "MX-GEN-005")).toBe("MX-GEN-002");
    expect(code(new Error("Meshy 402: Insufficient credits"), "MX-GEN-005")).toBe("MX-GEN-003");
    expect(code(new Error("Meshy 429: Too many requests"), "MX-GEN-005")).toBe("MX-GEN-004");
    expect(code(new Error("Meshy 503: unavailable"), "MX-GEN-005")).toBe("MX-NET-005");
    expect(code({ status: 402 }, "MX-GEN-005")).toBe("MX-GEN-003");
    expect(code(new Error("Meshy task failed: bad prompt"), "MX-GEN-005")).toBe("MX-GEN-005");
    expect(code(new Error("Meshy task timed out after 20 minutes"))).toBe("MX-GEN-006");
    expect(code(new Error("download failed (404)"))).toBe("MX-GEN-007");
    expect(code(named("MeshyNotConfigured"))).toBe("MX-GEN-001");
    expect(code(named("MeshFormatError", "not an STL"))).toBe("MX-GEN-008");
  });

  it("maps Gemini failures", () => {
    expect(code(new Error("Gemini is not configured. Add GEMINI_API_KEY"))).toBe("MX-VOICE-004");
    expect(code({ status: 429 }, "MX-GEN-010", "gemini")).toBe("MX-VOICE-005");
    expect(code({ status: 403 }, "MX-GEN-010", "gemini")).toBe("MX-VOICE-004");
    expect(code(new Error("HTTP 400 API key not valid. API_KEY_INVALID"), "MX-GEN-010", "gemini")).toBe("MX-VOICE-004");
    expect(code(errno("ECONNREFUSED"), "MX-VOICE-001")).toBe("MX-VOICE-002");
  });

  it("maps slicer results and failures", () => {
    expect(code({ ok: false, reason: "slicer-not-installed", message: "No slicer installed." })).toBe("MX-SLICE-001");
    expect(code({ ok: false, reason: "profile-missing", message: "x" })).toBe("MX-SLICE-002");
    expect(code({ ok: false, reason: "slicer-failed", message: "exit 1" })).toBe("MX-SLICE-003");
    expect(code({ ok: false, reason: "timeout", message: "prusaslicer timed out" }, "MX-SLICE-003")).toBe("MX-SLICE-004");
    expect(code({ ok: false, reason: "no-output", message: "x" })).toBe("MX-SLICE-005");
    expect(code({ ok: false, reason: "too-large", message: "Too large: 300 x 10 x 10 mm exceeds the 220 x 220 x 220 mm build volume" })).toBe("MX-SLICE-006");
    expect(code(errno("ENOENT", "spawn prusa-slicer ENOENT"), "MX-SLICE-003")).toBe("MX-SLICE-001");
    expect(code(new Error("Too large: 300.0 x 20.0 x 20.0 mm exceeds the 220 x 220 x 220 mm build volume"))).toBe("MX-SLICE-006");
    expect(code(errno("ENOENT", "spawn openscad ENOENT"), undefined, "openscad")).toBe("MX-GEN-011");
  });

  it("maps storage errors regardless of service", () => {
    expect(code(errno("ENOSPC"), "MX-PRINT-008")).toBe("MX-STORE-001");
    expect(code(new Error("write failed: No space left on device"))).toBe("MX-STORE-001");
    expect(code(errno("EROFS"))).toBe("MX-STORE-005");
    expect(code(errno("EACCES"))).toBe("MX-STORE-003");
    expect(code(errno("ENOENT"))).toBe("MX-STORE-002");
    expect(code(new Error("SQLITE_CORRUPT: database disk image is malformed"))).toBe("MX-STORE-004");
  });

  it("maps printer-controller errors and messages", () => {
    expect(code(named("ControllerDisabledError", "printer control is disabled"))).toBe("MX-PRINT-004");
    expect(code(named("ControlRefusedError", "unsafe state"))).toBe("MX-PRINT-005");
    expect(code(named("ControlRefusedError", "start needs an authorization token"))).toBe("MX-PRINT-012");
    expect(code(named("PrinterReplyTimeout"))).toBe("MX-PRINT-002");
    expect(code(named("PrinterConnectionClosed"))).toBe("MX-PRINT-003");
    expect(code(new Error("Printer control is locked. It is switched on only after the operator validation checklist"))).toBe("MX-PRINT-004");
    expect(code(new Error("Morphix's .gx output hasn't been verified against the official Afinia slicer yet"))).toBe("MX-PRINT-011");
    expect(code(new Error("print start not confirmed: printer did not report printing"))).toBe("MX-PRINT-006");
    expect(code(new Error("pause not confirmed"))).toBe("MX-PRINT-007");
    expect(code(new Error("pause not confirmed"), undefined, "camera")).toBe("MX-GUARD-007");
    expect(code(new Error("upload not confirmed: no reply"))).toBe("MX-PRINT-008");
    expect(code(new Error("the printer is already printing"))).toBe("MX-PRINT-009");
    expect(code(new Error("prepare the model for printing first"))).toBe("MX-PRINT-013");
  });

  it("maps camera and guardian failures", () => {
    expect(code(new Error("camera lost: read failed"))).toBe("MX-GUARD-001");
    expect(code({ status: "unavailable", reason: "daily_cap" })).toBe("MX-GUARD-006");
    expect(code({ ok: false, reason: "camera_lost" })).toBe("MX-GUARD-001");
  });

  it("maps Auth0 failures", () => {
    expect(code({ error: "access_denied", error_description: "Not on allow list" })).toBe("MX-AUTH-003");
    expect(code({ error: "login_required", error_description: "Login required" })).toBe("MX-AUTH-002");
    expect(code({ error: "invalid_grant" })).toBe("MX-AUTH-001");
    expect(code({ error: "something_new" }, "MX-AUTH-001")).toBe("MX-AUTH-001");
    expect(code(named("TokenExpiredError", "jwt expired"))).toBe("MX-AUTH-002");
    expect(code(new Error("state mismatch"), undefined, "auth0")).toBe("MX-AUTH-006");
    expect(code({ status: 503 }, "MX-AUTH-001")).toBe("MX-AUTH-005");
    expect(code({ status: 403 }, "MX-AUTH-001")).toBe("MX-AUTH-003");
  });

  it("maps cancellation, timeouts and the fallback", () => {
    expect(code(named("AbortError", "This operation was aborted"))).toBe("MX-SYS-004");
    expect(code(new Error("cancelled"))).toBe("MX-SYS-004");
    expect(code(named("TimeoutError", "The operation timed out"), "MX-PRINT-008")).toBe("MX-PRINT-002");
    expect(code(new Error("operation timed out"))).toBe("MX-SYS-007");
    expect(code(new Error("weird"), "MX-GEN-005")).toBe("MX-GEN-005");
    expect(code(new Error("weird"), "not-a-code")).toBe("MX-SYS-001");
    expect(code(undefined)).toBe("MX-SYS-001");
    expect(code("Meshy 402: no credits", "MX-GEN-005")).toBe("MX-GEN-003");
    expect(code({ code: "MX-SLICE-007" })).toBe("MX-SLICE-007");
  });

  it("keeps the cause, the technical message and useful context", () => {
    const cause = errno("ECONNREFUSED", "connect ECONNREFUSED 192.168.4.2:8899");
    const e = toMorphixError(cause, "MX-PRINT-008", { context: { host: "192.168.4.2" } });
    expect(e.cause).toBe(cause);
    expect(e.message).toBe("connect ECONNREFUSED 192.168.4.2:8899");
    expect(e.context).toEqual({ service: "printer", errno: "ECONNREFUSED", host: "192.168.4.2" });
    expect(toMorphixError(new Error("Meshy 429: slow down")).context.httpStatus).toBe(429);
  });

  it("withErrorCode wraps async failures", async () => {
    await expect(withErrorCode("MX-PRINT-008", async () => { throw errno("ECONNREFUSED"); })).rejects.toMatchObject({ code: "MX-PRINT-001" });
    await expect(withErrorCode("MX-PRINT-008", async () => 5)).resolves.toBe(5);
  });
});
