// Tiger Data (guardian history), Vultr (backup error diagnosis) and the Claude→Vultr chain.
// Fake database and network only.
import { describe, expect, it } from "vitest";
import { createTigerSink, type PgPoolLike } from "../apps/desktop/electron/tiger";
import { createVultrDiagnoser, firstDiagnoser, pickVultrModel, vultrDiagnoserFromEnv } from "@morphix/healer";

const incident: any = { incident: { kind: "unknown-error", what: "printer said E12", code: null, context: {} }, logLines: ["{\"level\":\"error\"}"], remediations: [{ id: "reconnectGemini", label: "Reconnect Gemini" }] };

describe("Tiger Data sink", () => {
  it("creates the hypertable once and inserts records with parameters", async () => {
    const queries: { text: string; values?: unknown[] }[] = [];
    const pool: PgPoolLike = { query: async (text, values) => (queries.push({ text, values }), { rows: [] }) };
    const sink = createTigerSink("postgres://x", { device: "pi", pool: async () => pool });
    await sink.insert([{ at: "2026-11-08T05:00:00Z", sessionId: "s1", type: "transition", state: "watching", data: { from: "idle" } }]);
    await sink.insert([{ at: "2026-11-08T05:00:10Z", sessionId: "s1", type: "event", kind: "spaghetti", value: 0.8 }]);
    expect(queries[0].text).toMatch(/CREATE TABLE IF NOT EXISTS guardian_telemetry/);
    expect(queries[1].text).toMatch(/create_hypertable/);
    expect(queries.filter((q) => /CREATE TABLE/.test(q.text))).toHaveLength(1); // set up once
    const inserts = queries.filter((q) => q.text.startsWith("INSERT"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].values).toEqual(["2026-11-08T05:00:00Z", "pi", "s1", "transition", null, "watching", null, '{"from":"idle"}']);
    expect(inserts[1].text).not.toContain("spaghetti"); // values never pasted into SQL
  });

  it("works on plain Postgres (no TimescaleDB) and retries the connection after a failure", async () => {
    let attempts = 0;
    const pool: PgPoolLike = { query: async (text) => { if (/create_hypertable/.test(text)) throw new Error("no timescaledb"); return {}; } };
    const sink = createTigerSink("postgres://x", { pool: async () => { if (++attempts === 1) throw new Error("offline"); return pool; } });
    await expect(sink.insert([{ at: "t", sessionId: null, type: "x" }])).rejects.toThrow(/offline/);
    await expect(sink.insert([{ at: "t", sessionId: null, type: "x" }])).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});

describe("Vultr diagnoser", () => {
  it("picks a chat model, asks for JSON and parses the diagnosis", async () => {
    const urls: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer vk");
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "bge-embed" }, { id: "llama-3.3-70b-instruct-fp8" }] });
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("llama-3.3-70b-instruct-fp8");
      return Response.json({ model: body.model, choices: [{ message: { content: 'Here: {"summary":"The printer lost Wi-Fi.","likely_cause":"TCP reset","user_hint":"Check the cable.","suggested_remediation":"none","confidence":"medium"}' } }] });
    };
    const d = createVultrDiagnoser({ apiKey: "vk", fetch: fakeFetch });
    const r = await d(incident);
    expect(r).toMatchObject({ summary: "The printer lost Wi-Fi.", confidence: "medium", model: "vultr:llama-3.3-70b-instruct-fp8" });
    await d(incident);
    expect(urls.filter((u) => u.endsWith("/models"))).toHaveLength(1); // model looked up once
  });

  it("is off without the inference key and skips non-chat models", () => {
    expect(vultrDiagnoserFromEnv({ VULTR_API_KEY: "account-key" })).toBeNull();
    expect(typeof vultrDiagnoserFromEnv({ VULTR_INFERENCE_API_KEY: "vk" })).toBe("function");
    expect(pickVultrModel(["whisper-large", "mistral-7b-instruct"])).toBe("mistral-7b-instruct");
    expect(pickVultrModel(["bge-embed"])).toBeNull();
  });

  it("takes over when Claude fails", async () => {
    const claude = async () => { throw new Error("Claude HTTP 529"); };
    const vultr = async () => ({ summary: "from vultr", likelyCause: "", userHint: "", suggestedRemediation: "none" as const, confidence: "low" as const, model: "vultr:x" });
    expect(await firstDiagnoser([claude, vultr])!(incident)).toMatchObject({ summary: "from vultr" });
    expect(firstDiagnoser([null, undefined])).toBeNull();
  });
});
