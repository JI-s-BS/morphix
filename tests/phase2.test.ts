import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiLive, MORPHIX_TOOLS, isAffirmative, toMillimetres } from "@morphix/gemini";
import { MeshyClient, MeshyGenerator, type ModelGenerator } from "@morphix/meshy";
import { box } from "./phase3-fixtures";
import { parseWifiList, splitTerse, NetworkManager } from "@morphix/network";
import { scaledCheck, stlSize, writeBinaryStl } from "@morphix/slicing";
import { Storage, Logger } from "@morphix/storage";
import { MorphixDb } from "@morphix/database";
import { Generation } from "../apps/desktop/electron/generation";
import { Actions, PolicyError } from "../apps/desktop/electron/actions";
import type { Ctx } from "../apps/desktop/electron/context";

describe("voice policy helpers", () => {
  it("only treats clear yeses as confirmation", () => {
    for (const yes of ["Yes", "yeah do it", "okay go ahead", "Sure, make it!", "yes please"]) expect(isAffirmative(yes)).toBe(true);
    for (const no of ["no", "not yet", "wait", "yes but not now", "don't do it", "what does it cost?", ""]) expect(isAffirmative(no)).toBe(false);
  });
  it("converts spoken sizes", () => {
    expect(toMillimetres(6, "in")).toBeCloseTo(152.4);
    expect(toMillimetres(10, "cm")).toBe(100);
    expect(toMillimetres(80, "mm")).toBe(80);
  });
  it("builds a push-to-talk Live setup with the Morphix tools", () => {
    const live = new GeminiLive("k", "gemini-3.8-live", "sys", MORPHIX_TOOLS, {} as never);
    const setup = live.setupMessage() as Record<string, any>;
    expect(setup.model).toBe("models/gemini-3.8-live");
    expect(setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(true);
    const names = setup.tools[0].functionDeclarations.map((f: { name: string }) => f.name);
    expect(names).toContain("generate_model");
    expect(names).toContain("confirm_pending_action");
    expect(names).not.toContain("start_print");
  });
});

describe("network (nmcli parsing)", () => {
  it("handles escaped colons", () => {
    expect(splitTerse("*:My\\:Net:80:WPA2")).toEqual(["*", "My:Net", "80", "WPA2"]);
  });
  it("dedupes access points and sorts", () => {
    const out = ":Home:40:WPA2\n*:Home:70:WPA2\n:Cafe:90:\n::55:WPA2\n";
    const list = parseWifiList(out, new Set(["Cafe"]));
    expect(list.map((n) => n.ssid)).toEqual(["Home", "Cafe"]);
    expect(list[0]).toMatchObject({ inUse: true, signal: 70 });
    expect(list[1]).toMatchObject({ saved: true, security: "" });
  });
  it("refuses bad passwords before calling nmcli", async () => {
    const calls: string[][] = [];
    const nm = new NetworkManager(async (args) => (calls.push(args), ""));
    await expect(nm.connect("Home", "short")).rejects.toThrow(/8 to 63/);
    expect(calls).toHaveLength(0);
  });
});

describe("Meshy client", () => {
  it("creates a preview, polls progress and downloads the files", async () => {
    const stl = writeBinaryStl(box(60, 60, 80));
    let polls = 0;
    const requests: { url: string; body?: unknown }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (url.endsWith("/openapi/v2/text-to-3d")) return json({ result: "task-1" });
      if (url.endsWith("/openapi/v2/text-to-3d/task-1")) {
        polls++;
        return json(
          polls < 3
            ? { id: "task-1", status: polls === 1 ? "PENDING" : "IN_PROGRESS", progress: polls * 40, preceding_tasks: 2 }
            : { id: "task-1", status: "SUCCEEDED", progress: 100, consumed_credits: 20, model_urls: { glb: "https://x/m.glb", stl: "https://x/m.stl" }, thumbnail_url: "https://x/t.png" },
        );
      }
      if (url === "https://x/m.glb") return new Response(Buffer.from("glTF-bytes"));
      if (url === "https://x/m.stl") return new Response(stl);
      if (url === "https://x/t.png") return new Response(Buffer.from("png"));
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const client = new MeshyClient("key", "meshy-6", "https://api.meshy.ai", fakeFetch);
    (client as unknown as { waitFor: MeshyClient["waitFor"] }).waitFor = ((id, cb, signal) =>
      MeshyClient.prototype.waitFor.call(client, id, cb, signal, 1)) as MeshyClient["waitFor"];
    const stages: string[] = [];
    let remote = "";
    const model = await new MeshyGenerator(client).generate("a dragon", (u) => stages.push(u.stage), { onRemoteId: (id) => (remote = id) });
    expect(remote).toBe("task-1");
    expect(model.format).toBe("glb");
    expect(model.stl?.length).toBe(stl.length);
    expect(model.credits).toBe(20);
    expect(stages.some((s) => s.includes("queue"))).toBe(true);
    expect(requests[0].body).toMatchObject({ mode: "preview", ai_model: "meshy-6", target_formats: ["glb", "stl"] });
  });

  it("surfaces API errors", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 })) as unknown as typeof fetch;
    await expect(new MeshyClient("bad", "meshy-6", "https://api.meshy.ai", fakeFetch).balance()).rejects.toThrow(/401: Invalid API key/);
  });
});

describe("STL sizing", () => {
  it("measures and scales", () => {
    const size = stlSize(writeBinaryStl(box(60, 60, 80)))!;
    expect(size.z).toBeCloseTo(80, 0);
    const check = scaledCheck(size, 152.4);
    expect(check.size.z).toBeCloseTo(152.4, 1);
    expect(check.fits).toBe(true);
    expect(scaledCheck(size, 400).fits).toBe(false);
  });
});

describe("cost policy", () => {
  async function setup(usingMeshy = true, dailyLimit = 2) {
    const storage = new Storage(mkdtempSync(join(tmpdir(), "morphix-p2-")));
    storage.init();
    const db = await MorphixDb.open(storage);
    const events: unknown[] = [];
    const ctx: Ctx = { db, storage, log: new Logger(storage), send: () => {}, event: (e) => events.push(e), url: (r) => (r ? `/library/${r}` : null), currentProjectId: null };
    let resolveGen: () => void = () => {};
    const gen: ModelGenerator = {
      name: usingMeshy ? "meshy" : "demo",
      generate: () =>
        new Promise((res) => {
          resolveGen = () => res({ format: "stl", data: writeBinaryStl(box(40, 40, 10)), remoteId: "r1", credits: 20 });
        }),
    };
    const generation = new Generation(ctx, () => gen, () => {});
    const actions = new Actions(ctx, generation, { usingMeshy: () => usingMeshy, meshyModel: "meshy-6", dailyLimit });
    return { ctx, db, actions, generation, events, finish: () => resolveGen() };
  }

  it("proposes with the right cost and only starts on confirm", async () => {
    const { actions, db, events } = await setup();
    const p = actions.proposeGenerate("a dragon figurine", "Dragon");
    expect(p.credits).toBe(20);
    expect(db.get("SELECT COUNT(*) AS n FROM generation_tasks")?.n).toBe(0);
    expect(events).toContainEqual({ type: "pending", action: p });
    expect(() => actions.confirm("wrong-id", "touch")).toThrow(PolicyError);
    const r = actions.confirm(p.id, "touch");
    expect(db.get("SELECT provider, status FROM generation_tasks WHERE id = ?", [r.taskId])).toMatchObject({ provider: "meshy" });
    expect(actions.current).toBeNull();
  });

  it("blocks a second job while one is running and enforces the daily cap", async () => {
    const { actions, finish } = await setup(true, 1);
    actions.confirm(actions.proposeGenerate("one", "One").id, "touch");
    expect(() => actions.proposeGenerate("two", "Two")).toThrow(/already being generated|limit/);
    finish();
    await new Promise((r) => setTimeout(r, 20));
    expect(() => actions.proposeGenerate("three", "Three")).toThrow(/Daily Meshy limit/);
  });

  it("stores Meshy results with an STL and a default display height", async () => {
    const { actions, db, finish } = await setup();
    actions.confirm(actions.proposeGenerate("a gear", "Gear").id, "touch");
    finish();
    await new Promise((r) => setTimeout(r, 20));
    const v = db.get("SELECT * FROM model_versions");
    expect(v).toMatchObject({ source: "meshy", kind: "preview", remote_task_id: "r1", target_height_mm: 80 });
    expect(String(v?.stl_rel_path)).toMatch(/model\.stl$/);
    expect(db.get("SELECT state FROM projects")?.state).toBe("reviewing");
  });

  it("refuses to refine non-Meshy models", async () => {
    const { actions } = await setup(false);
    expect(() => actions.proposeRefine(null)).toThrow(/no model|only Meshy/);
  });
});
