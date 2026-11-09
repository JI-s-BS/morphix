// My Things on the Pi (2026-11-08): with 17 things, every tile was squeezed to ~24 px tall so the
// pictures were cut off and no names showed. The grid is a height-limited scroll area and the
// tiles use overflow: hidden, which lets auto rows shrink to fit instead of scrolling.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("My Things grid", () => {
  it("sizes rows to their tiles so the grid scrolls instead of squeezing them", () => {
    const css = readFileSync(resolve(__dirname, "../apps/desktop/src/styles.css"), "utf8");
    const rule = css.match(/^\.grid\s*\{([^}]*)\}/m)?.[1] ?? "";
    expect(rule).toMatch(/overflow-y:\s*auto/);
    expect(rule).toMatch(/grid-auto-rows:\s*max-content/);
  });
});
