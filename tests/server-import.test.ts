// "Import a file" (My Things): model files from the user's device become a project with no AI keys.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IPC, type AppEvent, type Project } from "@morphix/shared";
import { createCore, type Core } from "../apps/server/src/core";
import { DEFAULT_CONFIG } from "../apps/server/src/setup-module";
import { boxStl } from "./photo3d-helpers";

let core: Core | null = null;
let dir = "";
afterEach(async () => {
  await core?.stop();
  core = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function start() {
  dir = mkdtempSync(join(tmpdir(), "morphix-import-"));
  core = await createCore({ dataDir: join(dir, "data"), repoRoot: resolve(__dirname, ".."), version: "test", config: structuredClone(DEFAULT_CONFIG) });
  await core.start();
  const events: AppEvent[] = [];
  core.registry.subscribe((ch, e) => ch === IPC.appEvent && events.push(e as AppEvent));
  const call = (ch: string, ...args: unknown[]) => core!.registry.call(ch, args);
  return { call, events };
}

const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe("importing model files", () => {
  it("makes a project from an STL at its exact size and opens it", async () => {
    const { call, events } = await start();
    const r = (await call(IPC.importModelFiles, [{ name: "phone_stand.stl", bytes: ab(boxStl(40, 30, 12)) }])) as { projectId: string; versionId: string; parts: string[] };
    expect(r.parts).toEqual(["phone_stand"]);
    const projects = (await call(IPC.listProjects)) as Project[];
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: r.projectId, title: "phone stand", state: "reviewing", latestVersionId: r.versionId });
    expect(events).toContainEqual({ type: "navigate", page: "viewer", projectId: r.projectId });
    const p = (await call(IPC.getProject, r.projectId)) as { versions: { stlUrl: string | null; targetHeightMm: number | null }[] };
    expect(p.versions[0].stlUrl).toMatch(/^\/library\/models\//);
    expect(p.versions[0].targetHeightMm).toBeNull(); // the file's own size
    const manifest = (await call(IPC.libraryManifest, r.versionId)) as { sourceName: string; parts: { sizeMm: { x: number; y: number; z: number } }[] };
    expect(manifest.sourceName).toBe("your file");
    expect(manifest.parts[0].sizeMm).toEqual({ x: 40, y: 30, z: 12 });
  });

  it("keeps several parts of one design together", async () => {
    const { call } = await start();
    const r = (await call(IPC.importModelFiles, [
      { name: "body.stl", bytes: ab(boxStl(20, 20, 20)) },
      { name: "lid.stl", bytes: ab(boxStl(20, 20, 4)) },
      { name: "README.txt", bytes: ab(Buffer.from("print the lid upside down")) },
    ])) as { parts: string[] };
    expect(r.parts.sort()).toEqual(["body", "lid"]);
  });

  it("says plainly when nothing printable was chosen", async () => {
    const { call } = await start();
    await expect(call(IPC.importModelFiles, [])).rejects.toThrow(/Choose between 1 and 200 model files/);
    await expect(call(IPC.importModelFiles, [{ name: "notes.txt", bytes: ab(Buffer.from("hi")) }])).rejects.toThrow(/No printable parts/);
    await expect(call(IPC.importModelFiles, [{ name: "broken.stl", bytes: ab(Buffer.from("not an stl")) }])).rejects.toThrow(/No printable parts/);
  });
});
