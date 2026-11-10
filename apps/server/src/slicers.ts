// Slicing for driver printers through the SlicerAdapter contract (packages/slicing/src/adapters).
// Tries the preferred slicer first, then the others, using only installed ones that can make the
// printer's file. Install lookups are cached; a failed lookup is retried on the next slice.
import * as slicing from "@morphix/slicing";
import type { PrinterModel } from "@morphix/catalog";
import type { SliceJob, SliceOutput, SlicerAdapter, SlicerId, SlicerInstall } from "@morphix/slicing";

export interface SlicerChoice {
  preferred?: SlicerId;
  paths?: Partial<Record<SlicerId, string>>;
}

/** The adapters packages/slicing exports as SLICERS (empty until that module provides them). */
export function installedAdapters(mod: unknown = slicing): SlicerAdapter[] {
  const reg = (mod as Record<string, unknown>).SLICERS;
  if (!reg || typeof reg !== "object") return [];
  return Object.values(reg as Record<string, SlicerAdapter>).filter((a) => a && typeof a.slice === "function" && typeof a.detect === "function");
}

export function createDriverSlicer(adapters: readonly SlicerAdapter[], choice: SlicerChoice = {}) {
  const installs = new Map<SlicerId, SlicerInstall>();
  const order = (): SlicerAdapter[] => {
    const pref = adapters.find((a) => a.id === choice.preferred);
    return pref ? [pref, ...adapters.filter((a) => a !== pref)] : [...adapters];
  };
  return async (job: SliceJob): Promise<{ out: SliceOutput; slicer: string | null }> => {
    const model: PrinterModel = job.printer;
    const able = order().filter((a) => a.supports(model));
    if (!able.length) {
      return { out: { ok: false, reason: "unsupported-printer", message: `No slicer in Morphix can make ${model.fileFormat} files for the ${model.brand} ${model.model} yet.` }, slicer: null };
    }
    for (const a of able) {
      let inst = installs.get(a.id) ?? null;
      if (!inst) {
        inst = await a.detect({ customPath: choice.paths?.[a.id] }).catch(() => null);
        if (inst) installs.set(a.id, inst);
      }
      if (!inst) continue;
      const out = await a.slice(inst, { timeoutMs: 15 * 60_000, ...job });
      return { out, slicer: `${a.name}${inst.version ? ` ${inst.version}` : ""}` };
    }
    const hint = able[0].installHint({ arch: process.arch });
    return { out: { ok: false, reason: "slicer-not-installed", message: `No slicer is installed for the ${model.brand} ${model.model}. ${hint}` }, slicer: null };
  };
}
