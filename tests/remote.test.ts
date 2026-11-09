import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@morphix/storage";
import { FakeBackend } from "@morphix/portal";
import { MorphixRemote } from "@morphix/remote";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));

describe("Morphix Remote pairing", () => {
  it("keeps APIs locked until a valid one-time code is paired", async () => {
    const root = mkdtempSync(join(tmpdir(), "morphix-remote-")); roots.push(root);
    const storage = new Storage(root); storage.init();
    const remote = new MorphixRemote({
      storage, backend: new FakeBackend({ storageRoot: root, tickMs: 0 }), conversation: () => [], jobs: () => [], assistantText: async () => {}, assistantVoice: async () => {},
      setHeight: () => ({}), proposeRefine: () => ({}), prepare: async () => ({ ok: false } as never), latestPrint: () => null,
      proposePrint: () => ({}), printStatus: () => ({ enabled: false, gxVerified: false, job: null, busy: null, lastMessage: null }),
      smartSearch: () => null, searchModels: async () => ({ id: "s", query: "q", status: "ready", results: [] }), selectModel: () => { throw new Error("none"); },
      importModels: async () => ({ projectId: "p", versionId: "v", parts: [], warnings: [] }),
      downloadModel: async () => ({ projectId: "p", versionId: "v", parts: [], warnings: [] }),
      pause: async () => ({ ok: false, message: "disabled" }), resume: async () => ({ ok: false, message: "disabled" }), cancel: async () => ({ ok: false, message: "disabled" }),
      guardian: () => ({ running: false } as never), guardianAnswer: async () => ({ ok: false, message: "disabled" }), log: () => {},
    }, { host: "127.0.0.1", port: 0, allowedOrigins: ["https://morphix.example"] });
    const { url, codeFile } = await remote.start();
    try {
      const locked = await fetch(`${url}/api/state`, { headers: { Origin: "https://morphix.example" } });
      expect(locked.status).toBe(401);
      const code = readFileSync(codeFile, "utf8").match(/\d{8}/)![0];
      const paired = await fetch(`${url}/api/pair`, { method: "POST", headers: { Origin: "https://morphix.example", "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "Test phone" }) });
      expect(paired.status).toBe(200);
      const { token } = await paired.json() as { token: string };
      const state = await fetch(`${url}/api/state`, { headers: { Origin: "https://morphix.example", Authorization: `Bearer ${token}` } });
      expect(state.status).toBe(200);
      const replay = await fetch(`${url}/api/pair`, { method: "POST", headers: { Origin: "https://morphix.example", "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "Stranger" }) });
      expect(replay.status).toBe(401);
      const badOrigin = await fetch(`${url}/api/state`, { headers: { Origin: "https://evil.example", Authorization: `Bearer ${token}` } });
      expect(badOrigin.status).toBe(403);
    } finally { await remote.stop(); }
  });
});
