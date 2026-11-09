import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@morphix/storage";
import { FakeBackend } from "@morphix/portal";
import { Photo3dError } from "@morphix/photo3d";
import { MorphixRemote, PHOTO_LIMITS, type RemoteDeps } from "@morphix/remote";
import { CLEAN_PNG, JPEG, PNG } from "./photo-app-helpers";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const ORIGIN = "https://morphix.example";

async function start(extra: Partial<RemoteDeps>) {
  const root = mkdtempSync(join(tmpdir(), "morphix-photo-remote-")); roots.push(root);
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
    ...extra,
  }, { host: "127.0.0.1", port: 0, allowedOrigins: [ORIGIN] });
  const { url, codeFile } = await remote.start();
  const code = readFileSync(codeFile, "utf8").match(/\d{8}/)![0];
  const paired = await fetch(`${url}/api/pair`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "Test phone" }) });
  const { token } = (await paired.json()) as { token: string };
  const headers = { Origin: ORIGIN, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const post = (path: string, body: unknown, h: Record<string, string> = headers) => fetch(`${url}${path}`, { method: "POST", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { remote, url, headers, post };
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

describe("Morphix Remote: Photo to 3D routes", () => {
  it("answers 503 until main wires the photo flow, and stays behind pairing", async () => {
    const s = await start({});
    try {
      expect((await s.post("/api/photo/analyze", { description: "x", images: [] })).status).toBe(503);
      const unpaired = await s.post("/api/photo/analyze", {}, { Origin: ORIGIN, "Content-Type": "application/json" });
      expect(unpaired.status).toBe(401);
    } finally { await s.remote.stop(); }
  });

  it("validates uploads and passes clean photos to analyze", async () => {
    const seen: any[] = [];
    const s = await start({
      photoAnalyze: async (input) => { seen.push(input); return { id: "plan1", recommended: "meshy" }; },
      photoCreate: async () => ({ jobId: "j1" }),
    });
    try {
      const ok = await s.post("/api/photo/analyze", { description: "  a keychain of my friend ", images: [{ name: "IMG_0001.HEIC<script>", data: b64(JPEG) }, { name: "b.png", data: b64(PNG) }] });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ plan: { id: "plan1", recommended: "meshy" } });
      expect(seen[0].description).toBe("a keychain of my friend");
      expect(seen[0].owner).toBe("morphix-remote");
      expect(seen[0].images.map((i: any) => i.mime)).toEqual(["image/jpeg", "image/png"]);
      expect(seen[0].images[0].name).toBe("IMG_0001.HEICscript");
      expect(Buffer.from(seen[0].images[0].bytes)).toEqual(Buffer.from(JPEG));

      const bad = async (body: unknown) => { const r = await s.post("/api/photo/analyze", body); return { status: r.status, body: (await r.json()) as any }; };
      expect(await bad({ description: "", images: [{ data: b64(JPEG) }] })).toMatchObject({ status: 400, body: { error: "description_required" } });
      expect(await bad({ description: "x", images: [] })).toMatchObject({ status: 400, body: { error: "photo_count" } });
      expect(await bad({ description: "x", images: Array(5).fill({ data: b64(JPEG) }) })).toMatchObject({ status: 400 });
      expect(await bad({ description: "x", images: [{ data: b64(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39])) }] })).toMatchObject({ status: 415, body: { error: "photo_type" } });
      const huge = Buffer.alloc(PHOTO_LIMITS.maxPhotoBytes + 10); huge.set(JPEG);
      expect(await bad({ description: "x", images: [{ data: huge.toString("base64").slice(0, 4_000_000) }] })).toMatchObject({ status: 413 });
      // Whole body over the Vercel-sized limit is refused before it is read.
      const tooBig = await s.post("/api/photo/analyze", JSON.stringify({ description: "x", images: [{ data: "A".repeat(PHOTO_LIMITS.maxBodyBytes + 100) }] }));
      expect(tooBig.status).toBe(413);
      expect(seen).toHaveLength(1);
    } finally { await s.remote.stop(); }
  });

  it("creates only with a valid route and maps pipeline errors to clear statuses", async () => {
    const creates: any[] = [];
    const s = await start({
      photoAnalyze: async () => ({}),
      photoCreate: async (input) => {
        creates.push(input);
        if (input.planId === "gone") throw new Photo3dError("MX-P3D-080");
        if (input.route === "cad") throw new Photo3dError("MX-P3D-070");
        return { jobId: "job-1", route: input.route, credits: 30 };
      },
    });
    try {
      const ok = await s.post("/api/photo/create", { planId: "plan1", route: "meshy", useOriginal: true });
      expect(ok.status).toBe(202);
      expect(await ok.json()).toEqual({ jobId: "job-1", route: "meshy", credits: 30 });
      expect(creates[0]).toEqual({ planId: "plan1", route: "meshy", useOriginal: true, owner: "morphix-remote" });

      expect((await s.post("/api/photo/create", { planId: "plan1", route: "print" })).status).toBe(400);
      expect((await s.post("/api/photo/create", { planId: "../etc", route: "meshy" })).status).toBe(400);
      const cad = await s.post("/api/photo/create", { planId: "plan1", route: "cad" });
      expect(cad.status).toBe(409);
      expect(await cad.json()).toMatchObject({ error: "MX-P3D-070", message: expect.stringMatching(/not available/i) });
      const gone = await s.post("/api/photo/create", { planId: "gone", route: "meshy" });
      expect(gone.status).toBe(404);
      expect(creates).toHaveLength(3);
    } finally { await s.remote.stop(); }
  });

  it("serves the cleaned preview and runs cleanup on request", async () => {
    const s = await start({
      photoAnalyze: async () => ({}),
      photoCreate: async () => ({}),
      photoClean: async (planId) => ({ id: planId, cleanup: { ready: true } }),
      photoPreview: (planId, index) => (planId === "plan1" && index === 0 ? { mime: "image/png", bytes: CLEAN_PNG } : null),
    });
    try {
      const img = await fetch(`${s.url}/api/photo/plans/plan1/preview/0`, { headers: s.headers });
      expect(img.status).toBe(200);
      expect(img.headers.get("content-type")).toBe("image/png");
      expect(img.headers.get("cache-control")).toContain("no-store");
      expect(Buffer.from(await img.arrayBuffer())).toEqual(Buffer.from(CLEAN_PNG));
      expect((await fetch(`${s.url}/api/photo/plans/plan1/preview/3`, { headers: s.headers })).status).toBe(404);
      const clean = await s.post("/api/photo/plans/plan1/clean", {});
      expect(await clean.json()).toEqual({ plan: { id: "plan1", cleanup: { ready: true } } });
    } finally { await s.remote.stop(); }
  });
});
