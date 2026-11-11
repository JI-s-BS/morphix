// Builds generator dependencies from the Morphix environment (process.env / the config store).
import type { ClaudeEffort } from "./claude";
import type { CadDeps } from "./generate";

const EFFORTS: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * ANTHROPIC_API_KEY (required to generate), MORPHIX_CLAUDE_MODEL (default claude-opus-5-5),
 * MORPHIX_CLAUDE_EFFORT (default high), MORPHIX_CLAUDE_FALLBACKS (0 disables the refusal
 * fallback beta), MORPHIX_OPENSCAD_BIN, MORPHIX_OPENSCAD_TIMEOUT_S (shared with photo3d).
 */
export function cadDepsFromEnv(env: Record<string, string | undefined> = process.env): CadDeps {
  const timeout = Number(env.MORPHIX_OPENSCAD_TIMEOUT_S);
  const effort = env.MORPHIX_CLAUDE_EFFORT?.trim().toLowerCase() as ClaudeEffort | undefined;
  return {
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() ?? "",
    model: env.MORPHIX_CLAUDE_MODEL?.trim() || undefined,
    effort: effort && EFFORTS.includes(effort) ? effort : undefined,
    fallbacks: !/^(0|false|no|off)$/i.test(env.MORPHIX_CLAUDE_FALLBACKS?.trim() ?? ""),
    openscadBin: env.MORPHIX_OPENSCAD_BIN?.trim() || undefined,
    openscadTimeoutMs: env.MORPHIX_OPENSCAD_TIMEOUT_S?.trim() && Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : undefined,
  };
}

/** True when the Claude CAD generator can run (an API key is set). */
export function cadConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.ANTHROPIC_API_KEY?.trim();
}
