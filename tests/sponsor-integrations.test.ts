// Vultr (backup error diagnosis) and the Claude→Vultr chain (packages/healer). Fake network only.
// (The Tiger Data sink was removed with the sponsor wiring; the app no longer uses Vultr either.)
import { describe, expect, it } from "vitest";
import { createVultrDiagnoser, firstDiagnoser, pickVultrModel, vultrDiagnoserFromEnv } from "@morphix/healer";

const incident: any = { incident: { kind: "unknown-error", what: "printer said E12", code: null, context: {} }, logLines: ["{\"level\":\"error\"}"], remediations: [{ id: "reconnectGemini", label: "Reconnect Gemini" }] };

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
