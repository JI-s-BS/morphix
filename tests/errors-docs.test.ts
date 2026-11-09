import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_ERROR_CODES, renderErrorsMarkdown } from "@morphix/errors";

const DOC = resolve(__dirname, "..", "docs", "ERRORS.md");

describe("docs/ERRORS.md", () => {
  it("is in sync with the registry (MORPHIX_UPDATE_DOCS=1 regenerates it)", () => {
    const md = renderErrorsMarkdown();
    if (process.env.MORPHIX_UPDATE_DOCS === "1") writeFileSync(DOC, md);
    expect(existsSync(DOC)).toBe(true);
    expect(readFileSync(DOC, "utf8")).toBe(md);
  });

  it("lists every core code", () => {
    const md = renderErrorsMarkdown();
    for (const e of CORE_ERROR_CODES) expect(md).toContain(`| \`${e.code}\` |`);
  });
});
