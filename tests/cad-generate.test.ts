import { describe, expect, it } from "vitest";
import { CadError, generateCadModel, type CadStage } from "@morphix/cad";
import { computeBounds, parseStl } from "@morphix/slicing";
import { answer, boxStl, fakeClaude, fakeOpenscad, messageBody, missingOpenscad, noSleep, openBoxStl } from "./cad-helpers";

const KEY = "sk-ant-test";

describe("generateCadModel", () => {
  it("returns the STL, source and size when the first design renders cleanly", async () => {
    const claude = fakeClaude([answer({ notes: ["Print flat."], assumptions: ["Bracket screws assumed M3."] })]);
    const scad = fakeOpenscad(() => ({ stl: boxStl(80, 60, 20) }));
    const stages: CadStage[] = [];
    const r = await generateCadModel({ description: "wall bracket for a shelf, 80 mm wide" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: scad.exec, onProgress: (s) => stages.push(s) });

    expect(r.attempts).toBe(1);
    expect(r.sizeMm.x).toBeCloseTo(80);
    expect(r.sizeMm.y).toBeCloseTo(60);
    expect(r.sizeMm.z).toBeCloseTo(20);
    expect(r.scad).toContain("cube");
    expect(r.notes).toContain("Print flat.");
    expect(r.assumptions).toEqual(["Bracket screws assumed M3."]);
    expect(r.device).toBeNull();
    expect(r.model).toBe("claude-opus-5-5");
    expect(r.triangles).toBe(12);
    expect(parseStl(r.stl).indices.length).toBe(36);
    expect(stages).toEqual(["designing", "rendering", "checking", "done"]);
    expect(scad.runs).toHaveLength(1);

    // Request shape: Messages API over plain fetch.
    expect(claude.calls).toHaveLength(1);
    const call = claude.calls[0];
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe(KEY);
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.body.model).toBe("claude-opus-5-5");
    expect(call.body.thinking).toEqual({ type: "adaptive" });
    expect(call.body.output_config.format.type).toBe("json_schema");
    expect(call.body.output_config.format.schema.required).toEqual(["scad", "sizeMm", "assumptions", "notes"]);
    expect(call.body.system).toMatch(/220 x 220 x 220/);
    expect(call.body.system).toMatch(/0\.4 mm nozzle/);
    expect(call.body.messages[0].content).toContain("wall bracket for a shelf");
  });

  it("reports each attempt's code and rendered model, for the live view on screen", async () => {
    const claude = fakeClaude([answer({ scad: "cube([10, 10 10]);" }), answer()]);
    const scad = fakeOpenscad((code) => (code.includes("10 10") ? { code: 1, stderr: "ERROR: Parser error" } : { stl: boxStl(80, 60, 20) }));
    const seen: { stage: CadStage; attempt?: number; scad?: string; stl?: number }[] = [];
    await generateCadModel({ description: "cable clip" }, {
      anthropicApiKey: KEY, fetch: claude.fetch, exec: scad.exec,
      onProgress: (stage, _d, info) => seen.push({ stage, attempt: info?.attempt, scad: info?.scad, stl: info?.stl?.length }),
    });
    expect(seen.map((s) => `${s.stage}:${s.attempt}`)).toEqual(["designing:1", "rendering:1", "repairing:1", "designing:2", "rendering:2", "checking:2", "done:2"]);
    expect(seen.find((s) => s.stage === "rendering")?.scad).toBe("cube([10, 10 10]);");
    expect(seen.find((s) => s.stage === "checking")?.stl).toBeGreaterThan(84);
    expect(seen.at(-1)?.stl).toBeGreaterThan(84);
  });

  it("uses the model override", async () => {
    const claude = fakeClaude([answer()]);
    const r = await generateCadModel({ description: "spacer" }, { anthropicApiKey: KEY, model: "claude-sonnet-5-5", fetch: claude.fetch, exec: fakeOpenscad(() => ({ stl: boxStl(80, 60, 20) })).exec });
    expect(claude.calls[0].body.model).toBe("claude-sonnet-5-5");
    expect(r.model).toBe("claude-sonnet-5-5");
  });

  it("sends OpenSCAD errors back to Claude and succeeds on the repaired code", async () => {
    const claude = fakeClaude([answer({ scad: "cube([10, 10 10]);" }), answer()]);
    const scad = fakeOpenscad((code) =>
      code.includes("10 10") ? { code: 1, stderr: "ERROR: Parser error in file model.scad, line 1: syntax error" } : { stl: boxStl(80, 60, 20) },
    );
    const stages: CadStage[] = [];
    const r = await generateCadModel({ description: "cable clip" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: scad.exec, onProgress: (s) => stages.push(s) });

    expect(r.attempts).toBe(2);
    expect(r.attemptLog.map((a) => a.outcome)).toEqual(["compile", "ok"]);
    expect(claude.prompt(1)).toContain("Parser error");
    expect(claude.prompt(1)).toContain("cube([10, 10 10]);");
    expect(stages).toContain("repairing");
  });

  it("gives up after maxAttempts with MX-CAD-021", async () => {
    const claude = fakeClaude([answer({ scad: "cube(;" })]);
    const scad = fakeOpenscad(() => ({ code: 1, stderr: "ERROR: Parser error" }));
    const err = await generateCadModel({ description: "gear", maxAttempts: 3 }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: scad.exec }).catch((e) => e);
    expect(err).toBeInstanceOf(CadError);
    expect(err.code).toBe("MX-CAD-021");
    expect(err.message).toMatch(/3 attempts/);
    expect(err.scad).toBe("cube(;");
    expect(claude.calls).toHaveLength(3);
    expect(scad.runs).toHaveLength(3);
  });

  it("defaults to 2 attempts (4 took too long on the Pi)", async () => {
    const claude = fakeClaude([answer({ scad: "cube(;" })]);
    await expect(generateCadModel({ description: "gear" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: fakeOpenscad(() => ({ code: 1, stderr: "ERROR" })).exec })).rejects.toMatchObject({ code: "MX-CAD-021" });
    expect(claude.calls).toHaveLength(2);
  });

  it("rejects a part bigger than the 220 mm build volume and asks for a smaller one", async () => {
    const claude = fakeClaude([answer({ sizeMm: { x: 250, y: 60, z: 20 } }), answer()]);
    let run = 0;
    const scad = fakeOpenscad(() => (++run === 1 ? { stl: boxStl(250, 60, 20) } : { stl: boxStl(80, 60, 20) }));
    const r = await generateCadModel({ description: "long shelf bracket" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: scad.exec });
    expect(r.attemptLog.map((a) => a.outcome)).toEqual(["too-large", "ok"]);
    expect(claude.prompt(1)).toMatch(/250\.0 x 60\.0 x 20\.0 mm, larger than the 220 x 220 x 220 mm build volume/);
    expect(r.sizeMm.x).toBeCloseTo(80);
  });

  it("never returns an out-of-volume part", async () => {
    const claude = fakeClaude([answer({ sizeMm: { x: 80, y: 60, z: 230 } })]);
    const scad = fakeOpenscad(() => ({ stl: boxStl(80, 60, 230) }));
    await expect(generateCadModel({ description: "tall tower", maxAttempts: 2 }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: scad.exec })).rejects.toMatchObject({ code: "MX-CAD-021", message: expect.stringMatching(/build volume/) });
  });

  it("rejects a non-manifold mesh", async () => {
    const claude = fakeClaude([answer(), answer()]);
    let run = 0;
    const scad = fakeOpenscad(() => (++run === 1 ? { stl: openBoxStl(80, 60, 20) } : { stl: boxStl(80, 60, 20) }));
    const r = await generateCadModel({ description: "enclosure" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: scad.exec });
    expect(r.attemptLog[0].outcome).toBe("non-manifold");
    expect(claude.prompt(1)).toMatch(/open edges/);
  });

  it("rejects unsafe code without running openscad", async () => {
    const claude = fakeClaude([answer({ scad: 'import("/etc/passwd");\ncube(1);' }), answer()]);
    const scad = fakeOpenscad(() => ({ stl: boxStl(80, 60, 20) }));
    const r = await generateCadModel({ description: "knob" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: scad.exec });
    expect(r.attemptLog[0].outcome).toBe("unsafe");
    expect(scad.runs).toHaveLength(1);
    expect(claude.prompt(1)).toMatch(/safety checks: import/);
  });

  it("treats an empty top-level object as a failure", async () => {
    const claude = fakeClaude([answer(), answer()]);
    let run = 0;
    const scad = fakeOpenscad(() => (++run === 1 ? { code: 1, stderr: "WARNING: No top level geometry to render" } : { stl: boxStl(80, 60, 20) }));
    const r = await generateCadModel({ description: "hinge" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: scad.exec });
    expect(r.attemptLog[0].outcome).toBe("empty");
  });

  it("asks again when the rendered size is far from the stated size, and accepts the match", async () => {
    const claude = fakeClaude([answer({ sizeMm: { x: 40, y: 60, z: 20 } }), answer()]);
    const scad = fakeOpenscad(() => ({ stl: boxStl(80, 60, 20) }));
    const r = await generateCadModel({ description: "mount" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: scad.exec });
    expect(r.attemptLog.map((a) => a.outcome)).toEqual(["size-mismatch", "ok"]);
    expect(claude.prompt(1)).toMatch(/you said it would be 40\.0 x 60\.0 x 20\.0 mm/);
  });

  it("returns a size-mismatched model with a warning when nothing better comes", async () => {
    const claude = fakeClaude([answer({ sizeMm: { x: 40, y: 60, z: 20 } })]);
    const r = await generateCadModel({ description: "mount", maxAttempts: 2 }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: fakeOpenscad(() => ({ stl: boxStl(80, 60, 20) })).exec });
    expect(r.attempts).toBe(2);
    expect(r.notes.join(" ")).toMatch(/differs from what Claude intended/);
  });

  it("drops a floating part onto the bed", async () => {
    const claude = fakeClaude([answer()]);
    const r = await generateCadModel({ description: "spacer" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: fakeOpenscad(() => ({ stl: boxStl(80, 60, 20, 5) })).exec });
    expect(computeBounds(parseStl(r.stl)).min.z).toBeCloseTo(0);
    expect(r.notes.join(" ")).toMatch(/Moved the part down 5\.00 mm/);
  });

  it("retries when Claude's answer is cut off at max_tokens", async () => {
    const claude = fakeClaude([{ body: messageBody('{"scad": "cube(', "max_tokens") }, answer()]);
    const r = await generateCadModel({ description: "gear" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: fakeOpenscad(() => ({ stl: boxStl(80, 60, 20) })).exec });
    expect(r.attemptLog[0].outcome).toBe("no-answer");
    expect(claude.prompt(1)).toMatch(/cut off/);
  });

  it("stops at once when Claude refuses", async () => {
    const claude = fakeClaude([{ body: messageBody("", "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: "" } }) }]);
    const err = await generateCadModel({ description: "thing" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: fakeOpenscad(() => ({})).exec }).catch((e) => e);
    expect(err.code).toBe("MX-CAD-014");
    expect(claude.calls).toHaveLength(1);
  });

  it("reports a missing openscad binary without retrying", async () => {
    const claude = fakeClaude([answer()]);
    await expect(generateCadModel({ description: "bracket" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: missingOpenscad, openscadBin: "/usr/bin/openscad" })).rejects.toMatchObject({ code: "MX-CAD-020" });
    expect(claude.calls).toHaveLength(1);
  });

  it("requires an API key and a description", async () => {
    await expect(generateCadModel({ description: "bracket" }, { anthropicApiKey: "" })).rejects.toMatchObject({ code: "MX-CAD-002" });
    await expect(generateCadModel({ description: "  " }, { anthropicApiKey: KEY })).rejects.toMatchObject({ code: "MX-CAD-001" });
  });

  it("honours an abort signal", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(generateCadModel({ description: "bracket" }, { anthropicApiKey: KEY, signal: ac.signal, fetch: fakeClaude([answer()]).fetch })).rejects.toMatchObject({ code: "MX-CAD-003" });
  });

  it("retries a 429 from the API, then succeeds", async () => {
    const claude = fakeClaude([{ status: 429, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), headers: { "retry-after": "1" } }, answer()]);
    const sleeps: number[] = [];
    const r = await generateCadModel({ description: "bracket" }, { anthropicApiKey: KEY, fetch: claude.fetch, sleep: async (ms) => void sleeps.push(ms), exec: fakeOpenscad(() => ({ stl: boxStl(80, 60, 20) })).exec });
    expect(r.attempts).toBe(1);
    expect(sleeps).toEqual([1000]);
    expect(claude.calls).toHaveLength(2);
  });

  it("maps a bad API key to MX-CAD-011", async () => {
    const claude = fakeClaude([{ status: 401, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) }]);
    await expect(generateCadModel({ description: "bracket" }, { anthropicApiKey: KEY, fetch: claude.fetch, sleep: noSleep })).rejects.toMatchObject({ code: "MX-CAD-011" });
  });
});

describe("device-fit requests", () => {
  it("uses the reference table for a known phone and says where the numbers come from", async () => {
    const claude = fakeClaude([answer({ sizeMm: { x: 80, y: 60, z: 20 }, assumptions: ["Camera island assumed 38 x 38 mm, top-left."] })]);
    const r = await generateCadModel({ description: "iPhone 15 Pro Max case with a hex pattern" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: fakeOpenscad(() => ({ stl: boxStl(80, 60, 20) })).exec });
    expect(r.device?.name).toBe("iPhone 15 Pro Max");
    expect(r.fitCritical).toBe(true);
    expect(claude.prompt(0)).toContain("159.9 x 76.7 x 8.25 mm");
    expect(claude.prompt(0)).toMatch(/camera island, buttons, ports/);
    expect(r.assumptions[0]).toMatch(/iPhone 15 Pro Max body 159\.9 x 76\.7 x 8\.25 mm .*Apple/);
    expect(r.assumptions).toContain("Camera island assumed 38 x 38 mm, top-left.");
  });

  it("tells Claude an unknown device is not in the table and surfaces its assumptions", async () => {
    const claude = fakeClaude([answer({ assumptions: ["iPhone 17 body assumed 150 x 72 x 8 mm (not verified)."] })]);
    const r = await generateCadModel({ description: "iPhone 17 case with a cool design" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: fakeOpenscad(() => ({ stl: boxStl(80, 60, 20) })).exec });
    expect(r.device).toBeNull();
    expect(r.fitCritical).toBe(true);
    expect(claude.prompt(0)).toMatch(/NOT in Morphix's reference table/);
    expect(r.assumptions).toEqual(["iPhone 17 body assumed 150 x 72 x 8 mm (not verified)."]);
  });

  it("adds a measure-first warning when Claude lists no assumptions for an unknown device", async () => {
    const claude = fakeClaude([answer({ assumptions: [] })]);
    const r = await generateCadModel({ description: "iPhone 17 case" }, { anthropicApiKey: KEY, fetch: claude.fetch, exec: fakeOpenscad(() => ({ stl: boxStl(80, 60, 20) })).exec });
    expect(r.assumptions.join(" ")).toMatch(/Measure your device before printing/);
  });

  it("passes user dimensions and photo analysis to Claude", async () => {
    const claude = fakeClaude([answer()]);
    await generateCadModel(
      { description: "replacement knob for my oven", dimensions: { "shaft diameter": 6, "flat depth": 4.6 }, photoAnalysis: { objectName: "oven knob", estimatedHeightMm: 25 } },
      { anthropicApiKey: KEY, fetch: claude.fetch, exec: fakeOpenscad(() => ({ stl: boxStl(80, 60, 20) })).exec },
    );
    const p = claude.prompt(0);
    expect(p).toContain("- shaft diameter: 6");
    expect(p).toContain("- flat depth: 4.6");
    expect(p).toContain('"objectName":"oven knob"');
    expect(p).toMatch(/has to fit something/);
  });
});

describe("live code while Claude writes", () => {
  it("reads a string field from JSON that is still streaming in", async () => {
    const { partialJsonString } = await import("@morphix/cad");
    expect(partialJsonString('{"name":"Stand","sc', "scad")).toBeNull();
    expect(partialJsonString('{"scad":"cube([10, 10, 5]);\\nsphere(', "scad")).toBe("cube([10, 10, 5]);\nsphere(");
    expect(partialJsonString('{"scad":"a = \\"x\\";\\t\\u00e9", "notes":[]}', "scad")).toBe('a = "x";\té');
    expect(partialJsonString('{"scad":"abc\\', "scad")).toBe("abc"); // cut in the middle of an escape
  });

  it("reports the answer text as the stream arrives", async () => {
    const { ClaudeClient } = await import("@morphix/cad");
    const events = [
      { type: "message_start", message: { model: "claude-opus-5-5", content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"scad":"cube(' } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '[1,2,3]);"}' } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ];
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        for (const e of events) {
          c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
          await new Promise((r) => setTimeout(r, 5));
        }
        c.close();
      },
    });
    const client = new ClaudeClient({ apiKey: "k", fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) });
    const seen: string[] = [];
    const r = await client.generateJson<{ scad: string }>({ system: "s", prompt: "p", schema: {}, onText: (t) => seen.push(t) });
    expect(r.value?.scad).toBe("cube([1,2,3]);");
    expect(seen.at(-1)).toBe('{"scad":"cube([1,2,3]);"}');
  });
});
