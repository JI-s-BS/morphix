// "Meshy, Claude or open source?": nothing is created until the user picks, a plain yes means
// Gemini's recommendation, and Claude CAD requests reach the designer with the user's words.
import { describe, expect, it } from "vitest";
import { VoiceController } from "../apps/desktop/electron/voice";
import { cadDescription, cadDimensions, cadGeneratorFromEnv } from "../apps/desktop/electron/cad";
import type { CadPhotoRequest } from "@morphix/photo3d";

function setup(opts: { claude?: boolean; designing?: string } = {}) {
  const events: any[] = [];
  const designed: { description: string; title: string }[] = [];
  const proposed: string[] = [];
  const searched: string[] = [];
  const ctx: any = { event: (e: unknown) => events.push(e), log: { write: () => {} }, db: { get: () => null } };
  const actions: any = { current: null, clear() { this.current = null; }, proposeGenerate: (prompt: string) => (proposed.push(prompt), { credits: 20 }) };
  let designing = opts.designing ?? null;
  const smartSearch: any = { search: async (q: string) => (searched.push(q), { status: "ready", results: [] }), lastFinishedAt: 0 };
  const v = new VoiceController(ctx, actions, {
    apiKey: undefined, model: "m", meshyBalance: async () => 100, printing: () => null, smartSearch,
    stopCad: () => { const t = designing; designing = null; return t; },
    claudeCad: () => (opts.claude === false ? null : (input) => (designed.push(input), { jobId: "job-1" })),
  });
  // Real time: a turn that starts after Gemini's question can answer it.
  const say = async (user: string) => {
    await new Promise((r) => setTimeout(r, 3));
    (v as any).turn = { startedAt: Date.now(), audioBytes: 0, user, assistant: "", audioRel: null, system: false };
    (v as any).lastUser = { text: user, at: (v as any).turn.startedAt };
    await new Promise((r) => setTimeout(r, 3));
  };
  const call = (name: string, args: Record<string, unknown>) => (v as any).tool({ name, args });
  // Gemini's own follow-up turn (after an app event): no user words in it.
  const followUp = () => ((v as any).turn = { startedAt: Date.now(), audioBytes: 0, user: "", assistant: "", audioRel: null, system: true });
  const batch = (name: string, args: Record<string, unknown>) => (v as any).handleTools([{ id: "c", name, args }]);
  return { v, events, designed, proposed, searched, say, call, followUp, batch };
}

describe("engine choice before creating", () => {
  it("refuses to create anything until Gemini has asked", async () => {
    const t = setup();
    await t.say("make me a dragon");
    expect(await t.call("generate_model", { prompt: "dragon", title: "Dragon" })).toMatchObject({ ok: false, error: expect.stringMatching(/offer_engines/) });
    expect(t.proposed).toEqual([]);
  });

  it("shows the buttons, waits for the answer, and a plain yes uses the recommendation", async () => {
    const t = setup();
    await t.say("make me an iPhone 17 case with a cool design");
    const offer = await t.call("offer_engines", { request: "iPhone 17 case", recommended: "claude", reason: "it has to fit the phone exactly" });
    expect(offer.ok).toBe(true);
    expect(t.events).toContainEqual(expect.objectContaining({ type: "engine-choice", choice: expect.objectContaining({ recommended: "claude", claudeAvailable: true }) }));
    // Same turn: Gemini mustn't answer for the user.
    expect(await t.call("design_with_claude", { prompt: "iPhone 17 case", title: "Case" })).toMatchObject({ ok: false });
    await t.say("yes");
    expect(await t.call("design_with_claude", { prompt: "iPhone 17 case, wave pattern", title: "Case" })).toMatchObject({ ok: true, status: "designing" });
    expect(t.designed).toEqual([{ description: "iPhone 17 case, wave pattern", title: "Case", baseScad: undefined }]);
  });

  it("a plain yes can't switch to an engine that wasn't recommended", async () => {
    const t = setup();
    await t.say("a dragon");
    await t.call("offer_engines", { request: "dragon", recommended: "meshy", reason: "it's a figure" });
    await t.say("yes please");
    expect(await t.call("design_with_claude", { prompt: "dragon", title: "Dragon" })).toMatchObject({ ok: false });
    expect(await t.call("generate_model", { prompt: "dragon", title: "Dragon" })).toMatchObject({ ok: true, status: "awaiting_user_confirmation" });
  });

  it("naming an engine counts as choosing it, including open source", async () => {
    const t = setup();
    await t.say("find an open-source robotic arm");
    expect((await t.call("search_models", { query: "robotic arm" })).ok).toBe(true);
    expect(t.searched).toEqual(["robotic arm"]);
    await t.say("make a phone stand with Claude");
    expect((await t.call("design_with_claude", { prompt: "phone stand", title: "Stand" })).ok).toBe(true);
  });

  it("uses the user's latest words when Gemini calls the tool in its own follow-up turn", async () => {
    const t = setup();
    await t.say("a 16 oz water bottle");
    await t.call("offer_engines", { request: "water bottle", recommended: "claude", reason: "exact volume" });
    await t.say("Use Claude");
    t.followUp();
    expect((await t.call("design_with_claude", { prompt: "16 oz bottle", title: "Bottle" })).ok).toBe(true);
  });

  it("stops Gemini retrying a refused tool in a loop", async () => {
    const t = setup();
    await t.say("a dragon");
    const sent: any[] = [];
    (t.v as any).live = { sendToolResponses: (r: any[]) => sent.push(...r) };
    for (let i = 0; i < 6; i++) await t.batch("generate_model", { prompt: "dragon", title: "Dragon" });
    expect(sent).toHaveLength(6);
    expect(sent.slice(0, 3).every((r) => /offer_engines/.test(r.response.error))).toBe(true);
    expect(sent.slice(3).every((r) => /^STOP/.test(r.response.error))).toBe(true);
    expect(t.proposed).toEqual([]);
  });

  it("cancel stops a running Claude design, and admits when nothing was running", async () => {
    const t = setup({ designing: "16 oz Water Bottle" });
    await t.say("cancel the job");
    expect(await t.call("cancel_pending_action", {})).toMatchObject({ ok: true, cancelled: [expect.stringMatching(/16 oz Water Bottle/)] });
    expect(await t.call("cancel_pending_action", {})).toMatchObject({ ok: false, error: expect.stringMatching(/nothing was cancelled/) });
  });

  it("'add a cap to it' sends the design on screen to Claude", async () => {
    const t = setup();
    (t.v as any).currentScad = () => "bottle_h = 164;";
    await t.say("use Claude to add a cap to it");
    await t.call("design_with_claude", { prompt: "add a screw-on cap", title: "Bottle with cap", change_current: true });
    expect(t.designed.at(-1)).toEqual({ description: "add a screw-on cap", title: "Bottle with cap", baseScad: "bottle_h = 164;" });
    await t.say("use Claude for a new hook");
    await t.call("design_with_claude", { prompt: "a wall hook", title: "Hook" });
    expect(t.designed.at(-1)).toEqual({ description: "a wall hook", title: "Hook", baseScad: undefined });
  });

  it("says so when Claude isn't switched on", async () => {
    const t = setup({ claude: false });
    await t.say("use claude for a bracket");
    expect(await t.call("design_with_claude", { prompt: "bracket", title: "Bracket" })).toMatchObject({ ok: false, error: expect.stringMatching(/ANTHROPIC_API_KEY/) });
  });
});

describe("Claude CAD adapter", () => {
  const none = { valueMm: 0, confidence: 0, method: "typical-size" as const };
  const req = (over: Partial<CadPhotoRequest> = {}): CadPhotoRequest => ({
    description: "a replacement for this clip", objectName: "Bag clip", summary: "A plastic spring clip, 60 mm long",
    dimensions: { width: none, depth: none, height: none }, spec: null, measurements: [], images: [], ...over,
  });

  it("passes the user's words, what the photos showed, and their measurements in mm", () => {
    expect(cadDescription(req())).toBe("a replacement for this clip\nObject: Bag clip.\nFrom the photos: A plastic spring clip, 60 mm long");
    expect(cadDimensions(req({ measurements: [{ label: "length", value: 6, unit: "cm" }, { label: "bad", value: -1, unit: "mm" }] }))).toEqual({ length: 60 });
  });

  it("is off without ANTHROPIC_API_KEY", () => {
    expect(cadGeneratorFromEnv({})).toBeNull();
    expect(typeof cadGeneratorFromEnv({ ANTHROPIC_API_KEY: "test" })).toBe("function");
  });
});
