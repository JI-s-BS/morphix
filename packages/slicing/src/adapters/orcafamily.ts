// OrcaSlicer and Bambu Studio share one command line (Orca is a Bambu Studio fork):
//   orca-slicer --slice 0 --arrange 1 --load-settings "<machine.json>;<process.json>"
//               --load-filaments <filament.json> [--export-3mf <name>.gcode.3mf] --outputdir <dir> model.stl
// Plain G-code lands in <dir>/plate_1.gcode; for Bambu printers --export-3mf writes the sliced
// plate (.gcode.3mf) that the printer takes. With a vendor profile (catalog vendorProfiles) the
// machine JSON only "inherits" the slicer's bundled printer, resolved from its system presets.
// UNVERIFIED: built from the slicers' CLI help and source, not yet run against every version.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PrinterModel } from "@morphix/catalog";
import { defaultExec, type ExecFileFn } from "../slicer";
import { commandFor, detectInstall, SPECS, type DetectOptions } from "./detect";
import { hintFor } from "./hints";
import { finishSlice, findGcode, tail, type MorphixSliceJob, type MorphixSliceOutput, type ProfileSource } from "./output";
import { filamentFor, orcaFilamentFor, orcaMachineJson, orcaProcessJson } from "./profile";
import { ufpReason } from "./prusaslicer";
import type { SlicerAdapter, SlicerId, SlicerInstall } from "./types";

type OrcaId = Extract<SlicerId, "orcaslicer" | "bambustudio">;

export function orcaArgs(o: { machine: string; process: string; filament: string; outDir: string; modelPath: string; export3mf?: string }): string[] {
  return [
    "--slice", "0",
    "--arrange", "1",
    "--load-settings", `${o.machine};${o.process}`,
    "--load-filaments", o.filament,
    ...(o.export3mf ? ["--export-3mf", o.export3mf] : []),
    "--outputdir", o.outDir,
    o.modelPath,
  ];
}

export function orcaUnsupportedReason(id: OrcaId, p: PrinterModel): string | null {
  const name = SPECS[id].name;
  if (p.fileFormat === "ufp") return ufpReason(p);
  if (p.gcodeFlavor === "bambu" && !p.vendorProfiles?.[id] && !p.startGcode) {
    return `${name} needs its Bambu Lab printer profile for the ${p.brand} ${p.model}, and the printer catalog names none (vendorProfiles.${id}): Morphix won't guess Bambu start G-code`;
  }
  return null;
}

async function find3mf(dir: string, name: string): Promise<string | null> {
  try {
    const names = await readdir(dir);
    if (names.includes(name)) return join(dir, name);
    const any = names.filter((n) => n.toLowerCase().endsWith(".3mf")).sort()[0];
    return any ? join(dir, any) : null;
  } catch {
    return null;
  }
}

function orcaFamily<I extends OrcaId>(id: I) {
  const spec = SPECS[id];
  return {
    id,
    name: spec.name,
    detect: (opts: DetectOptions = {}) => detectInstall(spec, opts),
    supports: (p: PrinterModel) => orcaUnsupportedReason(id, p) === null,
    installHint: (env: { distro?: string; arch?: string }) => hintFor(id, env),

    async slice(install: SlicerInstall, job: MorphixSliceJob, deps: { exec?: ExecFileFn } = {}): Promise<MorphixSliceOutput> {
      const p = job.printer;
      const reason = orcaUnsupportedReason(id, p);
      if (reason) return { ok: false, reason: "unsupported-printer", message: reason };
      const exec = deps.exec ?? defaultExec;
      await mkdir(job.outDir, { recursive: true });
      if (job.printableDir) await mkdir(job.printableDir, { recursive: true });
      const started = Date.now();
      const { filament, warnings } = filamentFor(p, job.filament);
      const base = job.baseName ?? "model";
      const want3mf = p.fileFormat === "gcode.3mf";
      const write = async (name: string, json: unknown) => {
        const path = join(job.outDir, name);
        await writeFile(path, JSON.stringify(json, null, 2));
        return path;
      };
      const processJson = await write("morphix-process.json", orcaProcessJson(p, job));
      const filamentJson = await write(`filament-${filament.id}.json`, orcaFilamentFor(p, filament));
      const timeoutMs = job.timeoutMs ?? 15 * 60 * 1000;
      const vendor = job.useVendorProfile === false ? undefined : p.vendorProfiles?.[id];

      const run = async (useVendor: boolean) => {
        const machine = await write("morphix-machine.json", orcaMachineJson(p, { vendor: useVendor ? vendor : undefined, zOffsetMm: job.zOffsetMm }));
        const args = orcaArgs({ machine, process: processJson, filament: filamentJson, outDir: job.outDir, modelPath: job.modelPath, export3mf: want3mf ? `${base}.gcode.3mf` : undefined });
        const cmd = commandFor(install, args, [job.outDir, dirname(job.modelPath)]);
        const r = await exec(cmd.file, cmd.args, { timeoutMs, cwd: job.outDir });
        const out = want3mf ? await find3mf(job.outDir, `${base}.gcode.3mf`) : await findGcode(job.outDir, undefined, [`${base}.gcode`]);
        return { args, r, out };
      };

      let profile: ProfileSource = vendor ? "vendor" : p.startGcode ? "catalog" : "generated";
      let { args, r, out } = await run(!!vendor);
      // A generated profile is a fair fallback, except for Bambu printers (no guessed start G-code).
      if (vendor && !r.timedOut && (r.code !== 0 || !out) && orcaUnsupportedReason(id, { ...p, vendorProfiles: undefined }) === null) {
        warnings.push(`${spec.name} could not use its printer profile "${vendor}" (${tail(r.stderr || r.stdout, 200).trim() || `exit ${r.code}`}): sliced with Morphix's generated profile instead`);
        profile = p.startGcode ? "catalog" : "generated";
        ({ args, r, out } = await run(false));
      }
      const log = tail(r.stdout + "\n" + r.stderr);
      if (r.timedOut) return { ok: false, reason: "timeout", message: `${spec.name} timed out after ${timeoutMs} ms`, install, args, log };
      if (r.code !== 0 && !out) return { ok: false, reason: "slicer-failed", message: `${spec.name} exited with code ${r.code}`, install, args, log };
      return finishSlice({ printer: p, job, install, filament, args, log, started, profile, warnings, ...(want3mf ? { threeMfPath: out } : { gcodePath: out }) });
    },
  } satisfies SlicerAdapter;
}

export const orcaFamilyAdapter = orcaFamily;
