// Claude + headless OpenSCAD (packages/cad) plugged into the photo pipeline and the voice
// assistant: one GenerateCadFn turns a request (typed, spoken or from photos) into an STL in mm.
import { cadConfigured, cadDepsFromEnv, generateCadModel, type CadStage } from "@morphix/cad";
import { toMm, type CadPhotoRequest, type GenerateCadFn } from "@morphix/photo3d";

const STAGE_PROGRESS: Record<CadStage, number> = { designing: 0.15, repairing: 0.3, rendering: 0.55, checking: 0.85, done: 1 };

/** Claude's request text: the user's words plus what the photos showed (if any). */
export function cadDescription(r: CadPhotoRequest): string {
  const lines = [r.description.trim()];
  if (r.objectName && !r.description.toLowerCase().includes(r.objectName.toLowerCase())) lines.push(`Object: ${r.objectName}.`);
  if (r.summary) lines.push(`From the photos: ${r.summary}`);
  return lines.filter(Boolean).join("\n");
}

/** User measurements in mm, by label (the only sizes Claude must treat as exact). */
export function cadDimensions(r: CadPhotoRequest): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of r.measurements) {
    const mm = toMm(m.value, String(m.unit));
    if (mm !== null && mm > 0) out[m.label] = mm;
  }
  return out;
}

/** The Claude CAD generator from ~/Morphix/config/morphix.env, or null without ANTHROPIC_API_KEY. */
export function cadGeneratorFromEnv(env: Record<string, string | undefined> = process.env): GenerateCadFn | null {
  if (!cadConfigured(env)) return null;
  return async (request, ctx) => {
    const photos = request.images.length > 0;
    const r = await generateCadModel(
      {
        description: cadDescription(request),
        dimensions: cadDimensions(request),
        photoAnalysis: photos || request.spec ? { objectName: request.objectName, estimatedSizeMm: request.dimensions, spec: request.spec } : undefined,
        baseScad: request.baseScad,
      },
      { ...cadDepsFromEnv(env), signal: ctx.signal, onProgress: (stage, detail, info) =>
          ctx.onProgress?.({ progress: STAGE_PROGRESS[stage], detail, stage, attempt: info?.attempt, maxAttempts: info?.maxAttempts, scad: info?.scad, previewStl: info?.stl }) },
    );
    const warnings = [...r.notes];
    if (r.assumptions.length) warnings.unshift(`Based on these measurements — check before printing: ${r.assumptions.join("; ")}`);
    return { stl: new Uint8Array(r.stl), scad: r.scad, warnings };
  };
}
