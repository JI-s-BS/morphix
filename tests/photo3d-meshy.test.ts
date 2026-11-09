import { describe, expect, it } from "vitest";
import { checkPhotos, MESHY_IMAGE_CREDITS, MeshyImageClient, meshyImageCost, meshyStatusCode, Photo3dError } from "@morphix/photo3d";
import { boxStl, fakeMeshy, HEIC, JPEG, PNG } from "./photo3d-helpers";

const one = checkPhotos([{ mime: "image/jpeg", bytes: JPEG }]);
const two = checkPhotos([{ mime: "image/jpeg", bytes: JPEG }, { mime: "image/png", bytes: PNG }]);

describe("Meshy image clients", () => {
  it("creates an image-to-3d task with a data URI, GLB+STL and no texture by default", async () => {
    const m = fakeMeshy();
    const t = await m.client.create(one);
    expect(t).toEqual({ id: "task-123", kind: "image-to-3d" });
    const c = m.calls[0];
    expect(c.url).toBe("https://api.meshy.ai/openapi/v1/image-to-3d");
    expect(c.headers.Authorization).toBe("Bearer meshy-test");
    expect(c.body.image_url).toMatch(/^data:image\/jpeg;base64,/);
    expect(c.body.target_formats).toEqual(["glb", "stl"]);
    expect(c.body.should_texture).toBe(false);
    expect(c.body.ai_model).toBe("meshy-7.1");
  });

  it("uses multi-image-to-3d for 2-4 photos and skips HEIC", async () => {
    const m = fakeMeshy();
    const imgs = checkPhotos([{ mime: "image/heic", bytes: HEIC }, ...two.map((p) => ({ mime: p.mime, bytes: p.bytes }))]);
    const t = await m.client.create(imgs, { texture: true, texturePrompt: "wood" });
    expect(t.kind).toBe("multi-image-to-3d");
    expect(m.calls[0].url).toBe("https://api.meshy.ai/openapi/v1/multi-image-to-3d");
    expect(m.calls[0].body.image_urls).toHaveLength(2);
    expect(m.calls[0].body.texture_prompt).toBe("wood");
    await expect(m.client.create(checkPhotos([{ mime: "image/heic", bytes: HEIC }]))).rejects.toMatchObject({ code: "MX-P3D-001" });
  });

  it("maps HTTP statuses to clear codes", async () => {
    expect(meshyStatusCode(400)).toBe("MX-P3D-021");
    expect(meshyStatusCode(401)).toBe("MX-P3D-022");
    expect(meshyStatusCode(402)).toBe("MX-P3D-023");
    expect(meshyStatusCode(403)).toBe("MX-P3D-024");
    expect(meshyStatusCode(429)).toBe("MX-P3D-025");
    expect(meshyStatusCode(503)).toBe("MX-P3D-026");
    const m = fakeMeshy({ createStatus: 402, createBody: JSON.stringify({ message: "Insufficient credits" }) });
    await expect(m.client.create(one)).rejects.toMatchObject({ code: "MX-P3D-023", message: "Meshy 402: Insufficient credits" });
    await expect(new MeshyImageClient({}).create(one)).rejects.toMatchObject({ code: "MX-P3D-020" });
  });

  it("polls with progress, downloads GLB + STL and reports credits", async () => {
    const stl = boxStl(10, 10, 10);
    const m = fakeMeshy({
      polls: [
        { status: "PENDING", progress: 0, preceding_tasks: 2 },
        { status: "IN_PROGRESS", progress: 40 },
        { status: "SUCCEEDED", progress: 100, consumed_credits: 20, model_urls: { glb: "https://files.test/m.glb", stl: "https://files.test/m.stl" }, thumbnail_url: "https://files.test/t.png" },
      ],
      files: { "m.glb": Buffer.from("glTF-ish"), "m.stl": stl, "t.png": 500 },
    });
    const updates: number[] = [];
    let id: unknown;
    const r = await m.client.generate(one, { onProgress: (p) => updates.push(p.progress), onTaskId: (t) => (id = t) });
    expect(id).toEqual({ kind: "image-to-3d", id: "task-123" });
    expect(updates).toEqual([0, 40, 100]);
    expect(r.stl?.equals(stl)).toBe(true);
    expect(r.glb?.toString()).toBe("glTF-ish");
    expect(r.thumbnail).toBeUndefined(); // thumbnail failures are ignored
    expect(r.credits).toBe(20);
    expect(m.calls[1].url).toBe("https://api.meshy.ai/openapi/v1/image-to-3d/task-123");
  });

  it("resumes an existing task without creating (or paying for) a new one", async () => {
    const m = fakeMeshy({ polls: [{ status: "SUCCEEDED", progress: 100, model_urls: { stl: "https://files.test/m.stl" } }], files: { "m.stl": boxStl(5, 5, 5) } });
    const r = await m.client.generate([], { resume: { kind: "multi-image-to-3d", id: "old-9" } });
    expect(m.calls.some((c) => c.method === "POST")).toBe(false);
    expect(m.calls[0].url).toBe("https://api.meshy.ai/openapi/v1/multi-image-to-3d/old-9");
    expect(r.taskId).toBe("old-9");
  });

  it("reports failed tasks, timeouts and missing models", async () => {
    const failed = fakeMeshy({ polls: [{ status: "FAILED", task_error: { message: "image too dark" } }] });
    await expect(failed.client.generate(one)).rejects.toMatchObject({ code: "MX-P3D-027", message: expect.stringContaining("image too dark") });
    const none = fakeMeshy({ polls: [{ status: "SUCCEEDED", progress: 100, model_urls: {} }] });
    await expect(none.client.generate(one)).rejects.toMatchObject({ code: "MX-P3D-029" });
    const slow = fakeMeshy({ polls: [{ status: "IN_PROGRESS", progress: 5 }] });
    const client = new MeshyImageClient({ apiKey: "k", fetch: (slow.client as any).fetchFn, pollMs: 1, timeoutMs: 5 });
    await expect(client.generate(one)).rejects.toMatchObject({ code: "MX-P3D-028" });
  });

  it("cancels while polling", async () => {
    const m = fakeMeshy({ polls: [{ status: "IN_PROGRESS", progress: 5 }] });
    const client = new MeshyImageClient({ apiKey: "k", fetch: (m.client as any).fetchFn, pollMs: 50 });
    const ctl = new AbortController();
    const p = client.generate(one, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    await expect(p).rejects.toBeInstanceOf(Photo3dError);
    await expect(p).rejects.toMatchObject({ code: "MX-P3D-090" });
  });

  it("knows the published credit costs", () => {
    expect(meshyImageCost()).toBe(20);
    expect(meshyImageCost({ texture: true })).toBe(30);
    expect(meshyImageCost({ model: "meshy-6-lite" })).toBe(5);
    expect(meshyImageCost({ geometryResolution: "2k" })).toBe(25);
    expect(MESHY_IMAGE_CREDITS["meshy-6-lite"].textured).toBe(15);
  });
});
