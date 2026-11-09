// Standard stage lists for every pipeline. Weights are relative shares of the bar,
// tuned so the bar moves steadily on a Pi 4 (generation and printing dominate).
import type { JobKind, JobStage } from "./types";

export interface StageTemplate {
  key: string;
  label: string;
  weight: number;
  group?: string;
  groupLabel?: string;
}

const PREPARE_GROUP = { group: "prepare", groupLabel: "Getting it ready to print" };

export const PREPARE_STAGES: readonly StageTemplate[] = [
  { key: "prepare.check", label: "Checking the model", weight: 2, ...PREPARE_GROUP },
  { key: "prepare.repair", label: "Fixing little problems", weight: 2, ...PREPARE_GROUP },
  { key: "prepare.orient", label: "Finding the best way to stand it up", weight: 2, ...PREPARE_GROUP },
  { key: "prepare.slice", label: "Cutting it into thin layers", weight: 8, ...PREPARE_GROUP },
  { key: "prepare.gx", label: "Making the printer file", weight: 1, ...PREPARE_GROUP },
];

export const APPROVAL_STAGE: StageTemplate = { key: "approval", label: "Waiting for your OK", weight: 1 };

export const PRINT_STAGES: readonly StageTemplate[] = [
  { key: "send", label: "Sending it to the printer", weight: 4 },
  { key: "print", label: "Printing", weight: 40 },
];

export const DONE_STAGE: StageTemplate = { key: "done", label: "All done!", weight: 0 };

export interface TemplateOptions {
  /** Include the "waiting for your OK" stage before sending (default true). */
  approval?: boolean;
  /** Include sending + printing (default true). false stops after preparation. */
  print?: boolean;
  /** text-/photo-to-print: who builds the model (default "meshy"). OpenSCAD (Claude CAD) has no download stage. */
  builder?: "meshy" | "openscad";
  /** photo-to-print: include the follow-up questions stage (default true; skip it at run time if none). */
  questions?: boolean;
}

function tail(o: TemplateOptions): StageTemplate[] {
  const out: StageTemplate[] = [...PREPARE_STAGES];
  if (o.print !== false) {
    if (o.approval !== false) out.push(APPROVAL_STAGE);
    out.push(...PRINT_STAGES);
  }
  out.push(DONE_STAGE);
  return out;
}

/** The standard stages for a job kind. */
export function stageTemplate(kind: JobKind, o: TemplateOptions = {}): StageTemplate[] {
  switch (kind) {
    case "text-to-print":
      if (o.builder === "openscad")
        return [
          { key: "understand", label: "Understanding your idea", weight: 4 },
          { key: "build", label: "Claude is designing your part", weight: 12 },
          ...tail(o),
        ];
      return [
        { key: "understand", label: "Understanding your idea", weight: 4 },
        { key: "generate", label: "Creating your 3D model", weight: 30 },
        { key: "download", label: "Bringing the model home", weight: 3 },
        ...tail(o),
      ];
    case "photo-to-print": {
      const openscad = o.builder === "openscad";
      return [
        { key: "photos", label: "Looking at your photos", weight: 8 },
        ...(o.questions !== false ? [{ key: "questions", label: "A few quick questions", weight: 2 }] : []),
        { key: "build", label: openscad ? "Building your model from shapes" : "Creating your 3D model", weight: openscad ? 10 : 30 },
        ...(openscad ? [] : [{ key: "download", label: "Bringing the model home", weight: 3 }]),
        ...tail(o),
      ];
    }
    case "prepare":
      return [...PREPARE_STAGES, DONE_STAGE];
    case "print":
      return [...(o.approval !== false ? [APPROVAL_STAGE] : []), ...PRINT_STAGES, DONE_STAGE];
  }
}

/** Fresh pending stages from templates. */
export function stagesFrom(templates: readonly StageTemplate[]): JobStage[] {
  const keys = new Set<string>();
  return templates.map((t) => {
    if (!t.key) throw new TypeError("stage key is required");
    if (keys.has(t.key)) throw new TypeError(`duplicate stage key "${t.key}"`);
    keys.add(t.key);
    if (!(t.weight >= 0) || !Number.isFinite(t.weight)) throw new RangeError(`stage "${t.key}": weight must be a finite number >= 0`);
    const s: JobStage = { key: t.key, label: t.label, weight: t.weight, status: "pending", progress: 0 };
    if (t.group) s.group = t.group;
    if (t.groupLabel) s.groupLabel = t.groupLabel;
    return s;
  });
}
