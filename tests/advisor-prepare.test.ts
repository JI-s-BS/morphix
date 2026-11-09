import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareWithAdvice, prusaArgs, writeBinaryStl, type AdvisorFetch, type Mesh, type SlicerInfo } from "@morphix/slicing";
import { trackPrepare, JobManager } from "@morphix/jobs";
import { box, fakeSlicerExec, ORCA_GCODE } from "./phase3-fixtures";
import { tShape } from "./advisor-fixtures";

const PROFILES = resolve(__dirname, "..", "config", "slicer-profiles");
const PRUSA: SlicerInfo = { kind: "prusaslicer", path: "/usr/bin/prusa-slicer", version: "2.9.0" };
const ORCA: SlicerInfo = { kind: "orcaslicer", path: "/opt/OrcaSlicer/orca-slicer", version: "2.2.0" };
const NO_SLICER = { searchPath: [] as string[], env: {} };

async function stl(mesh: Mesh): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "morphix-adv-"));
  const path = join(dir, "in.stl");
  await writeFile(path, writeBinaryStl(mesh));
  return { path, dir };
}

const argAfter = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

describe("prusaArgs (backwards compatible)", () => {
  it("adds brim and perimeter flags only when asked", () => {
    const base = { stlPath: "/m.stl", outPath: "/o.gcode", ini: "/p.ini", supports: "none" as const, center: { x: 110, y: 110 } };
    expect(prusaArgs(base)).not.toContain("--brim-width");
    expect(prusaArgs(base)).not.toContain("--perimeters");
    const args = prusaArgs({ ...base, brimWidthMm: 5, perimeters: 3 });
    expect(argAfter(args, "--brim-width")).toBe("5");
    expect(argAfter(args, "--perimeters")).toBe("3");
    expect(args.at(-1)).toBe("/m.stl");
  });
});

describe("prepareWithAdvice", () => {
  it("advises, then slices with the advised settings", async () => {
    const { path, dir } = await stl(box(10, 10, 80, { x: 50, y: 50, z: 0 }));
    const { exec, calls } = fakeSlicerExec();
    const stages: string[] = [];
    const r = await prepareWithAdvice({
      inputPath: path,
      description: "a tall tower",
      availableSlicers: [PRUSA],
      onProgress: (s) => stages.push(s),
      options: { upAxis: "z", orientation: "keep", exec, profilesDir: PROFILES, outputDir: join(dir, "out") },
    });
    expect(r.ok).toBe(true);
    expect(r.advice).toMatchObject({ source: "heuristic", slicer: "prusaslicer", brim: true, brimWidthMm: 8, orientation: "keep" });
    expect(r.applied).toMatchObject({ slicer: PRUSA, brimWidthMm: 8, perimeters: 2, supports: "none", layerHeightMm: 0.2, orientation: "keep", overriddenByCaller: ["orientation"] });
    const slice = calls.find((c) => c.args.includes("--export-gcode"))!;
    expect(argAfter(slice.args, "--brim-width")).toBe("8");
    expect(argAfter(slice.args, "--perimeters")).toBe("2");
    expect(argAfter(slice.args, "--layer-height")).toBe("0.2");
    expect(slice.args).not.toContain("--support-material");
    expect(stages).toEqual(["load", "validate", "repair", "place", "advise", "slice", "gx", "done"]);
    expect(r.size.z).toBeCloseTo(80, 3);
    expect(r.overhang.overhangAreaMm2).toBe(0);
    expect(r.files.gx).toBeDefined();
    expect(r.report.input.triangles).toBe(12);
  });

  it("lets the caller's explicit options win", async () => {
    const { path } = await stl(tShape());
    const { exec, calls } = fakeSlicerExec();
    const r = await prepareWithAdvice({
      inputPath: path,
      availableSlicers: [PRUSA],
      options: { orientation: "keep", supports: "none", layerHeightMm: 0.3, exec, profilesDir: PROFILES },
    });
    expect(r.advice.supports).toBe("buildplate");
    expect(r.applied.supports).toBe("none");
    expect(r.applied.overriddenByCaller).toEqual(expect.arrayContaining(["supports", "layerHeightMm", "orientation"]));
    const slice = calls.find((c) => c.args.includes("--export-gcode"))!;
    expect(slice.args).not.toContain("--support-material");
    expect(argAfter(slice.args, "--layer-height")).toBe("0.3");
  });

  it("applies advised build-plate supports", async () => {
    const { path } = await stl(tShape());
    const { exec, calls } = fakeSlicerExec();
    await prepareWithAdvice({ inputPath: path, availableSlicers: [PRUSA], options: { upAxis: "z", orientation: "keep", exec, profilesDir: PROFILES } });
    expect(calls.find((c) => c.args.includes("--export-gcode"))!.args).toContain("--support-material-buildplate-only");
  });

  it("re-runs with the original pose when the advisor wants to keep a decorative model upright", async () => {
    const { path } = await stl(box(10, 10, 80, { x: 50, y: 50, z: 0 }));
    const { exec } = fakeSlicerExec();
    const r = await prepareWithAdvice({ inputPath: path, intendedUse: "decorative", availableSlicers: [PRUSA], options: { upAxis: "z", exec, profilesDir: PROFILES } });
    expect(r.advice.orientation).toBe("keep");
    expect(r.orientation.unchanged).toBe(true);
    expect(r.size.z).toBeCloseTo(80, 3);
    expect(r.applied.brimWidthMm).toBe(8);
  });

  it("writes brim and walls into the OrcaSlicer process file", async () => {
    const { path, dir } = await stl(box(10, 10, 80, { x: 50, y: 50, z: 0 }));
    const { exec } = fakeSlicerExec(ORCA_GCODE);
    const r = await prepareWithAdvice({ inputPath: path, intendedUse: "functional", availableSlicers: [ORCA], options: { upAxis: "z", orientation: "keep", exec, profilesDir: PROFILES, outputDir: dir } });
    expect(r.advice.slicer).toBe("orcaslicer");
    const proc = JSON.parse(await readFile(join(dir, "slice", "morphix-process.json"), "utf8"));
    expect(proc).toMatchObject({ brim_type: "outer_only", brim_width: "8", wall_loops: "3", sparse_infill_density: "30%" });
  });

  it("explains a missing slicer and still returns the advice", async () => {
    const { path } = await stl(box(30, 30, 30, { x: 50, y: 50, z: 0 }));
    const r = await prepareWithAdvice({ inputPath: path, options: { detect: NO_SLICER, profilesDir: PROFILES } });
    expect(r.ok).toBe(false);
    expect(r.slicer).toMatchObject({ ok: false, reason: "slicer-not-installed" });
    expect(r.advice.slicer).toBeNull();
    expect(r.advice.warnings.join(" ")).toMatch(/PrusaSlicer/);
  });

  it("stops before slicing when the model is too big", async () => {
    const { path } = await stl(box(30, 30, 30));
    const r = await prepareWithAdvice({ inputPath: path, targetHeightMm: 300, availableSlicers: [PRUSA], options: { orientation: "keep", profilesDir: PROFILES } });
    expect(r.fits.fits).toBe(false);
    expect(r.slicer).toMatchObject({ ok: false, reason: "too-large" });
    expect(r.advice.warnings.join(" ")).toMatch(/too big/);
  });

  it("uses Gemini when configured and feeds the job tracker", async () => {
    const { path } = await stl(box(30, 30, 30, { x: 50, y: 50, z: 0 }));
    const { exec, calls } = fakeSlicerExec();
    const answer = { layer_height_mm: 0.16, infill_percent: 25, walls: 3, supports: "none", orientation: "auto", brim: false, brim_width_mm: 0, reasons: ["Finer layers for a smooth finish."], confidence: 0.7 };
    const fetch: AdvisorFetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }), text: async () => "" });
    const jobs = new JobManager();
    const job = jobs.create({ kind: "prepare", title: "Cube" });
    const t = trackPrepare(jobs, job.id);
    const r = await prepareWithAdvice({ inputPath: path, availableSlicers: [PRUSA], gemini: { apiKey: "k", fetch }, onProgress: t.onProgress, options: { upAxis: "z", exec, profilesDir: PROFILES } });
    const done = t.finish(r);
    expect(r.advice).toMatchObject({ source: "gemini", layerHeightMm: 0.16, infillPercent: 25, walls: 3 });
    expect(argAfter(calls.find((c) => c.args.includes("--export-gcode"))!.args, "--fill-density")).toBe("25%");
    expect(done.status).toBe("done");
    expect(done.percent).toBe(100);
  });
});
