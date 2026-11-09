// Renders docs/ERRORS.md from the registry. tests/errors-docs.test.ts fails when the
// committed file is out of date; regenerate with:
//   MORPHIX_UPDATE_DOCS=1 ./node_modules/.bin/vitest run tests/errors-docs.test.ts
import { ERROR_AREAS, type ErrorCodeEntry } from "./codes";
import { listErrorCodes } from "./registry";

const SEVERITY_ICON: Record<ErrorCodeEntry["severity"], string> = { info: "info", warning: "warning", error: "error", critical: "**critical**" };

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderErrorsMarkdown(entries: readonly ErrorCodeEntry[] = listErrorCodes({ core: true })): string {
  const lines: string[] = [
    "# Morphix error codes",
    "",
    "<!-- GENERATED from packages/errors/src/codes.ts. Do not edit by hand. -->",
    "<!-- Regenerate: MORPHIX_UPDATE_DOCS=1 ./node_modules/.bin/vitest run tests/errors-docs.test.ts -->",
    "",
    "Every failure Morphix shows has one code, `MX-<AREA>-<nnn>`. The **title** and **what to try**",
    "columns are shown to users (they are written for kids). The **technical description** is for logs,",
    "support and developers. **Retry** means trying the same thing again later can work without",
    "changing anything. See `packages/errors` for the API (`MorphixError`, `toMorphixError`).",
    "",
    "Codes are never renumbered or reused. Add new codes at the end of their area.",
    "",
    "## Using it",
    "",
    "```ts",
    "import { MorphixError, toMorphixError, userMessage, registerErrorCodes } from \"@morphix/errors\";",
    "",
    "// Throw a specific code (cause and context are optional; context is sanitised).",
    "throw new MorphixError(\"MX-PRINT-004\", { context: { action: \"start\" } });",
    "",
    "// Convert anything thrown. The fallback code's area picks the service, so ECONNREFUSED",
    "// becomes MX-PRINT-001 for printer calls and MX-NET-001 for cloud calls.",
    "try { await controller.startPrint({ jobId, fileName, authorization }); }",
    "catch (e) { const err = toMorphixError(e, \"MX-PRINT-006\"); log.error(err.code, err.message); }",
    "",
    "// Or name the service explicitly: \"printer\" | \"meshy\" | \"gemini\" | \"gemini-live\" | \"auth0\" |",
    "// \"camera\" | \"slicer\" | \"openscad\" | \"storage\" | \"network\" | \"portal\"",
    "toMorphixError(e, \"MX-GEN-010\", { service: \"gemini\", context: { jobId } });",
    "",
    "// Over IPC / HTTP send err.toJSON() (JSON.stringify does it automatically);",
    "// toMorphixError(json) or MorphixError.fromJSON(json) turns it back into an error.",
    "// Show users userMessage(err): \"<title>. <hint>\".",
    "",
    "// packages/photo3d, once at start-up:",
    "registerErrorCodes([{ code: \"MX-P3D-001\", title: \"…\", hint: \"…\", description: \"…\",",
    "  severity: \"warning\", retryable: true }], { owner: \"packages/photo3d\" });",
    "```",
    "",
    "Wire form (`SerializedMorphixError`): `{ name: \"MorphixError\", code, area, title, hint, message,",
    "severity, retryable, at, context?, cause? }`. Secrets (keys named like token/apiKey/password,",
    "bearer tokens, `?key=` query values) are redacted from context and causes.",
    "",
    "## Areas",
    "",
    "| Area | What | Owner |",
    "| --- | --- | --- |",
  ];
  for (const [k, v] of Object.entries(ERROR_AREAS)) lines.push(`| \`${k}\` | ${cell(v.name)} | ${cell(v.owner)} |`);
  lines.push("");
  lines.push("`MX-P3D-*` is reserved for `packages/photo3d`, which registers its own codes at start-up with");
  lines.push("`registerErrorCodes([...], { owner: \"packages/photo3d\" })` and documents them in its own docs.");
  for (const [k, v] of Object.entries(ERROR_AREAS)) {
    const rows = entries.filter((e) => e.area === k);
    if (!rows.length) continue;
    lines.push("", `## ${k}: ${v.name}`, "", "| Code | Title (shown to users) | What to try | Technical description | Severity | Retry |", "| --- | --- | --- | --- | --- | --- |");
    for (const e of rows) {
      lines.push(`| \`${e.code}\` | ${cell(e.title)} | ${cell(e.hint)} | ${cell(e.description)} | ${SEVERITY_ICON[e.severity]} | ${e.retryable ? "yes" : "no"} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
