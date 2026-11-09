import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage, StorageError, safeFilename, safeId } from "@morphix/storage";
import { MorphixDb } from "@morphix/database";
import { buildShape, DemoGenerator, pickShape, toBinaryStl } from "@morphix/meshy";
import { DemoAssistant, speechStats } from "@morphix/gemini";

const tmpStorage = () => {
  const s = new Storage(mkdtempSync(join(tmpdir(), "morphix-")));
  s.init();
  return s;
};

describe("storage", () => {
  it("creates the layout and blocks path traversal", () => {
    const s = tmpStorage();
    for (const d of ["models", "previews", "prints", "database", "config", "logs"]) expect(existsSync(join(s.root, d))).toBe(true);
    expect(() => s.path("..", "etc", "passwd")).toThrow(StorageError);
    expect(() => safeId("../x")).toThrow(StorageError);
    expect(safeFilename("../../my model?.stl")).toBe("my_model_.stl");
  });

  it("writes atomically", () => {
    const s = tmpStorage();
    const f = s.path("models", "a", "b.txt");
    s.writeAtomic(f, "hello");
    expect(readFileSync(f, "utf8")).toBe("hello");
  });
});

describe("database", () => {
  it("persists across reopen and recovers interrupted tasks", async () => {
    const s = tmpStorage();
    const db = await MorphixDb.open(s);
    const t = new Date().toISOString();
    db.run("INSERT INTO projects(id,title,prompt,state,created_at,updated_at) VALUES ('p1','t','p','generating',?,?)", [t, t]);
    db.run("INSERT INTO generation_tasks(id,project_id,provider,kind,status,prompt,created_at,updated_at) VALUES ('g1','p1','demo','preview','running','p',?,?)", [t, t]);
    db.setSetting("theme", { dark: true });
    db.close();
    const db2 = await MorphixDb.open(s);
    expect(db2.getSetting("theme", null)).toEqual({ dark: true });
    expect(db2.recoverInterruptedTasks()).toEqual([]);
    expect(db2.get("SELECT status FROM generation_tasks WHERE id='g1'")?.status).toBe("failed");
    expect(db2.get("SELECT state FROM projects WHERE id='p1'")?.state).toBe("failed");
    db2.close();
  });
});

describe("demo adapters", () => {
  it("builds valid binary STL for every shape", () => {
    for (const shape of ["vase", "torus", "star", "gear"] as const) {
      const tris = buildShape(shape);
      const stl = toBinaryStl(tris);
      expect(stl.readUInt32LE(80)).toBe(tris.length);
      expect(stl.length).toBe(84 + tris.length * 50);
    }
    expect(pickShape("a small vase")).toBe("vase");
    expect(pickShape("a gear")).toBe("gear");
  });

  it("generates a model with progress updates", async () => {
    const updates: number[] = [];
    const m = await new DemoGenerator(1).generate("a ring", (u) => updates.push(u.progress));
    expect(m.format).toBe("stl");
    expect(updates.at(-1)).toBe(100);
  });

  it("tells silence from speech", async () => {
    const silent = Buffer.alloc(16000 * 2);
    expect(speechStats(silent, 16000).rms).toBe(0);
    const loud = Buffer.alloc(16000 * 2);
    for (let i = 0; i < 16000; i++) loud.writeInt16LE(Math.round(Math.sin(i / 5) * 12000), i * 2);
    const a = new DemoAssistant();
    expect((await a.hearAudio(loud, 16000)).reply.text).toMatch(/hear you/);
    expect((await a.hearText("a dragon")).proposedPrompt).toBe("a dragon");
  });
});
