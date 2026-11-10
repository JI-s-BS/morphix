// Builds pipeline dependencies from the Morphix environment (process.env / the config store).
import { geminiJsonFromEnv } from "./gemini";
import { meshyImageFromEnv, meshyImageModelFromEnv } from "./meshy-image";
import type { PhotoToModelDeps } from "./pipeline";

/**
 * GEMINI_API_KEY, MORPHIX_GEMINI_VISION_MODEL, MESHY_API_KEY, MORPHIX_MESHY_IMAGE_MODEL,
 * MORPHIX_OPENSCAD_BIN, MORPHIX_OPENSCAD_TIMEOUT_S, MORPHIX_PHOTO3D_MAX_CREDITS.
 */
export function photo3dDepsFromEnv(env: Record<string, string | undefined> = process.env): PhotoToModelDeps {
  const num = (v: string | undefined) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const timeout = num(env.MORPHIX_OPENSCAD_TIMEOUT_S);
  return {
    gemini: geminiJsonFromEnv(env),
    meshy: meshyImageFromEnv(env),
    openscad: { bin: env.MORPHIX_OPENSCAD_BIN?.trim() || "openscad", timeoutMs: timeout !== undefined ? timeout * 1000 : undefined },
    maxCredits: num(env.MORPHIX_PHOTO3D_MAX_CREDITS),
    meshyDefaults: { model: meshyImageModelFromEnv(env) },
  };
}
