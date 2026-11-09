import { describe, expect, it } from "vitest";
import { cadConfigured, cadDepsFromEnv, ClaudeClient, FALLBACK_BETA, parseJsonText, parseSseMessage } from "@morphix/cad";
import { answer, fakeClaude } from "./cad-helpers";

const schema = { type: "object" };

function sse(events: unknown[]): string {
  return events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

describe("ClaudeClient", () => {
  it("streams with adaptive thinking, high effort, structured output and the default refusal fallback", () => {
    const c = new ClaudeClient({ apiKey: " k " });
    const body = c.buildBody({ system: "s", prompt: "p", schema });
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema } },
      system: "s",
      messages: [{ role: "user", content: "p" }],
      fallbacks: "default",
    });
    expect(body).not.toHaveProperty("temperature");
    expect(c.headers()).toEqual({ "content-type": "application/json", "x-api-key": "k", "anthropic-version": "2023-06-01", "anthropic-beta": FALLBACK_BETA });
  });

  it("leaves out fallbacks for models without them, or when disabled", () => {
    const old = new ClaudeClient({ apiKey: "k", model: "claude-haiku-5-5" });
    expect(old.buildBody({ system: "s", prompt: "p", schema })).not.toHaveProperty("fallbacks");
    expect(old.headers()).not.toHaveProperty("anthropic-beta");
    expect(new ClaudeClient({ apiKey: "k", fallbacks: false }).buildBody({ system: "s", prompt: "p", schema })).not.toHaveProperty("fallbacks");
  });

  it("reads a streamed answer", async () => {
    const stream = sse([
      { type: "message_start", message: { model: "claude-opus-5-5", content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "x" } },
      { type: "content_block_stop", index: 0 },
      { type: "ping" },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: '{"scad": "cube(1);",' } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: ' "notes": []}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]);
    const claude = fakeClaude([{ body: stream, contentType: "text/event-stream" }]);
    const c = new ClaudeClient({ apiKey: "k", fetch: claude.fetch });
    const r = await c.generateJson<{ scad: string }>({ system: "s", prompt: "p", schema });
    expect(r.value?.scad).toBe("cube(1);");
    expect(r.stopReason).toBe("end_turn");
    expect(r.model).toBe("claude-opus-5-5");
  });

  it("keeps only the text after a fallback hop and notes refusals", () => {
    const m = parseSseMessage(
      sse([
        { type: "message_start", message: { model: "claude-opus-5-5", content: [] } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } },
        { type: "content_block_start", index: 1, content_block: { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } } },
        { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "{}" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ]),
    );
    expect(m.text).toBe("{}");
    expect(m.model).toBe("claude-opus-5");
    const refused = parseSseMessage(sse([{ type: "message_delta", delta: { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } } }]));
    expect(refused).toMatchObject({ stopReason: "refusal", refusalCategory: "cyber" });
  });

  it("turns a stream error event into an error", async () => {
    const claude = fakeClaude([{ body: sse([{ type: "error", error: { type: "api_error", message: "boom" } }]), contentType: "text/event-stream" }]);
    await expect(new ClaudeClient({ apiKey: "k", fetch: claude.fetch }).generateJson({ system: "s", prompt: "p", schema })).rejects.toMatchObject({ code: "MX-CAD-010" });
  });

  it("drops the fallback beta once if the API rejects it", async () => {
    const claude = fakeClaude([{ status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fallbacks: unknown beta" } }) }, answer()]);
    const c = new ClaudeClient({ apiKey: "k", fetch: claude.fetch });
    const r = await c.generateJson<{ scad: string }>({ system: "s", prompt: "p", schema });
    expect(r.value?.scad).toContain("cube");
    expect(claude.calls[0].body.fallbacks).toBe("default");
    expect(claude.calls[1].body).not.toHaveProperty("fallbacks");
    expect(claude.calls[1].headers).not.toHaveProperty("anthropic-beta");
  });

  it("maps an unknown model to MX-CAD-015 without retrying", async () => {
    const claude = fakeClaude([{ status: 404, body: JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: nope" } }) }]);
    await expect(new ClaudeClient({ apiKey: "k", model: "nope", fetch: claude.fetch }).generateJson({ system: "s", prompt: "p", schema })).rejects.toMatchObject({ code: "MX-CAD-015" });
    expect(claude.calls).toHaveLength(1);
  });

  it("gives up on persistent 5xx after the retries", async () => {
    const claude = fakeClaude([{ status: 529, body: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) }]);
    await expect(new ClaudeClient({ apiKey: "k", fetch: claude.fetch, sleep: async () => undefined }).generateJson({ system: "s", prompt: "p", schema })).rejects.toMatchObject({ code: "MX-CAD-012" });
    expect(claude.calls).toHaveLength(3);
  });

  it("parses JSON with fences or prose around it", () => {
    expect(parseJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonText('Here you go: {"a":1} enjoy')).toEqual({ a: 1 });
    expect(parseJsonText("no json")).toBeNull();
  });
});

describe("cadDepsFromEnv", () => {
  it("reads the key, model, effort and openscad settings", () => {
    const d = cadDepsFromEnv({ ANTHROPIC_API_KEY: " sk ", MORPHIX_CLAUDE_MODEL: "claude-sonnet-5-5", MORPHIX_CLAUDE_EFFORT: "XHIGH", MORPHIX_OPENSCAD_BIN: "/usr/bin/openscad", MORPHIX_OPENSCAD_TIMEOUT_S: "600", MORPHIX_CLAUDE_FALLBACKS: "0" });
    expect(d).toEqual({ anthropicApiKey: "sk", model: "claude-sonnet-5-5", effort: "xhigh", fallbacks: false, openscadBin: "/usr/bin/openscad", openscadTimeoutMs: 600_000 });
  });

  it("falls back to defaults", () => {
    expect(cadDepsFromEnv({})).toEqual({ anthropicApiKey: "", model: undefined, effort: undefined, fallbacks: true, openscadBin: undefined, openscadTimeoutMs: undefined });
    expect(cadDepsFromEnv({ MORPHIX_CLAUDE_EFFORT: "huge" }).effort).toBeUndefined();
    expect(cadConfigured({})).toBe(false);
    expect(cadConfigured({ ANTHROPIC_API_KEY: "x" })).toBe(true);
  });
});
