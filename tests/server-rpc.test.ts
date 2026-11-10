// MorphixApi over HTTP: RPC round trip (JSON + binary), errors, SSE push events, and the
// browser client (createHttpApi) against the real server.
import { afterEach, describe, expect, it } from "vitest";
import { IPC, createHttpApi, decodeWire, encodeWire, type PrinterStatus, type VoiceEvent } from "@morphix/shared";
import { readEvents, startTestServer, type TestServer } from "./server-helpers";

let s: TestServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

describe("wire format", () => {
  it("round-trips binary values inside JSON", () => {
    const pcm = new Int16Array([1, -2, 300]).buffer;
    const back = decodeWire(JSON.parse(JSON.stringify(encodeWire([{ name: "a.stl", bytes: pcm }, 5, null])))) as [{ name: string; bytes: ArrayBuffer }, number, null];
    expect(back[0].name).toBe("a.stl");
    expect([...new Int16Array(back[0].bytes)]).toEqual([1, -2, 300]);
    expect(back.slice(1)).toEqual([5, null]);
  });
  it("drops prototype keys when decoding", () => {
    const v = decodeWire(JSON.parse('{"__proto__":{"polluted":true},"a":1}')) as Record<string, unknown>;
    expect(v).toEqual({ a: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("POST /api/rpc/<channel>", () => {
  it("calls the handler with the JSON args and returns { result }", async () => {
    s = await startTestServer();
    const seen: unknown[][] = [];
    s.registry.handle(IPC.setTargetHeight, (...args: unknown[]) => {
      seen.push(args);
      return { id: args[0], targetHeightMm: args[1] };
    });
    const r = await s.client("tok-user").rpc(IPC.setTargetHeight, ["v1", 80]);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ result: { id: "v1", targetHeightMm: 80 } });
    expect(seen).toEqual([["v1", 80]]);
  });

  it("carries binary args (PCM audio) and binary results as base64", async () => {
    s = await startTestServer();
    let got: ArrayBuffer | null = null;
    s.registry.handle(IPC.voiceTurn, (pcm: ArrayBuffer, rate: number) => {
      got = pcm;
      return { echo: pcm, rate };
    });
    const pcm = new Int16Array([7, 8, 9]).buffer;
    const r = await s.client("tok-user").rpc(IPC.voiceTurn, encodeWire([pcm, 16000]) as unknown[]);
    expect(r.status).toBe(200);
    expect([...new Int16Array(got!)]).toEqual([7, 8, 9]);
    const res = decodeWire((await r.json()).result) as { echo: ArrayBuffer; rate: number };
    expect([...new Int16Array(res.echo)]).toEqual([7, 8, 9]);
    expect(res.rate).toBe(16000);
  });

  it("returns the coded error message the UI turns into a friendly card", async () => {
    s = await startTestServer();
    s.registry.handle(IPC.requestPrint, () => {
      throw new Error("prepare the model for printing first");
    });
    const r = await s.client("tok-user").rpc(IPC.requestPrint, ["j1"]);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("rpc");
    expect(j.error.message).toMatch(/^MX-[A-Z0-9]+-\d{3}\|.*\|.*\|prepare the model for printing first$/);
  });

  it("refuses non-array bodies, bad JSON and unknown channels", async () => {
    s = await startTestServer();
    s.registry.handle(IPC.jobs, () => []);
    const c = s.client("tok-user");
    expect((await c.fetch(`/api/rpc/${IPC.jobs}`, { method: "POST", body: '{"a":1}' })).status).toBe(400);
    expect((await c.fetch(`/api/rpc/${IPC.jobs}`, { method: "POST", body: "{nope" })).status).toBe(400);
    expect((await c.rpc("no:such-channel")).status).toBe(404);
    // A known channel nobody registered yet.
    expect((await c.rpc(IPC.wifiScan)).status).toBe(501);
    expect((await c.rpc(IPC.jobs)).status).toBe(200);
  });
});

describe("GET /api/events (SSE)", () => {
  it("streams push events to signed-in users, binary included", async () => {
    s = await startTestServer();
    const r = await s.client("tok-user").fetch("/api/events");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const events = readEvents(r, 2);
    await new Promise((ok) => setTimeout(ok, 50));
    const status: PrinterStatus = { online: true, checkedAt: "2026-01-01T00:00:00Z", machine: "READY" };
    s.registry.emit(IPC.printerStatusEvent, status);
    s.registry.emit("not:an-event-channel", { secret: 1 });
    s.registry.emit(IPC.voiceEvent, { type: "audio", pcm: new Int16Array([5]).buffer, sampleRate: 24000 });
    const got = await events;
    expect(got[0]).toEqual({ event: IPC.printerStatusEvent, data: status });
    expect(got[1].event).toBe(IPC.voiceEvent);
    const audio = decodeWire(got[1].data) as Extract<VoiceEvent, { type: "audio" }>;
    expect([...new Int16Array(audio.pcm)]).toEqual([5]);
  });

  it("needs a signed-in user and drops listeners when the browser goes away", async () => {
    s = await startTestServer();
    expect((await s.client().fetch("/api/events")).status).toBe(401);
    const ctrl = new AbortController();
    const r = await s.client("tok-user").fetch("/api/events", { signal: ctrl.signal });
    expect(r.status).toBe(200);
    expect(s.registry.listenerCount).toBe(1);
    ctrl.abort();
    await new Promise((ok) => setTimeout(ok, 100));
    expect(s.registry.listenerCount).toBe(0);
  });

  it("closes the stream at the next heartbeat once the user is signed out", async () => {
    s = await startTestServer({ heartbeatMs: 50 });
    const c = s.client("tok-user");
    const r = await c.fetch("/api/events");
    c.cookies.delete("mx_test"); // the fake auth reads the original request; simulate revocation:
    const auth = s.auth;
    auth.userFor = async () => null;
    const reader = r.body!.getReader();
    const deadline = Date.now() + 2000;
    let done = false;
    while (!done && Date.now() < deadline) done = (await reader.read()).done;
    expect(done).toBe(true);
  });
});

describe("createHttpApi (browser client)", () => {
  it("implements MorphixApi over RPC with the CSRF token and decodes binary results", async () => {
    s = await startTestServer();
    s.registry.handle(IPC.getSettings, () => ({ demoMode: false }));
    s.registry.handle(IPC.voiceTurn, (pcm: ArrayBuffer) => ({ bytes: pcm.byteLength }));
    s.registry.handle(IPC.log, () => undefined);
    s.registry.handle(IPC.cancelPrint, () => {
      throw new Error("nothing to cancel");
    });
    const browser = s.client("tok-user");
    const f: typeof fetch = async (input, init) => {
      const u = new URL(String(input), s!.url);
      return browser.fetch(u.pathname, { ...init, csrf: (init?.headers as Record<string, string> | undefined)?.["X-Morphix-CSRF"] ?? false });
    };
    const api = createHttpApi({ base: "", fetch: f, cookie: () => [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ") });
    expect(await api.getSettings()).toEqual({ demoMode: false });
    await expect(api.voiceTurn(new Int16Array([1, 2]).buffer, 16000)).resolves.toEqual({ bytes: 4 });
    await expect(api.cancelPrint()).rejects.toThrow(/nothing to cancel/);
    api.log("info", "hello"); // never throws
  });

  it("reports 401 so the setup page can ask the user to sign in", async () => {
    s = await startTestServer();
    s.registry.handle(IPC.jobs, () => []);
    const anon = s.client();
    const codes: (string | undefined)[] = [];
    const api = createHttpApi({
      fetch: async (input, init) => anon.fetch(new URL(String(input), s!.url).pathname, { ...init, csrf: (init?.headers as Record<string, string>)?.["X-Morphix-CSRF"] ?? false }),
      cookie: () => [...anon.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      onUnauthorized: (c) => codes.push(c),
    });
    await expect(api.jobs()).rejects.toThrow(/sign in/i);
    expect(codes).toEqual(["unauthenticated"]);
  });
});
