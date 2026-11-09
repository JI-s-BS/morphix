// Pi touchscreen (2026-11-08): confirmations used window.confirm(), whose tiny OK/Cancel are
// hard to hit. They now use the in-app dialog (components/ConfirmDialog.tsx) with big buttons.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../apps/desktop/src");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : []));

describe("touch-friendly confirmations", () => {
  it("no page uses the system confirm/alert/prompt pop-ups", () => {
    const offenders = files(SRC)
      .filter((f) => !f.endsWith("ConfirmDialog.tsx"))
      .filter((f) => /(^|[^.\w])(confirm|alert|prompt)\(/m.test(readFileSync(f, "utf8").replace(/\/\/.*$/gm, "")));
    expect(offenders).toEqual([]);
  });

  it("the dialog's buttons are big enough to hit", () => {
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    const rule = css.match(/\.confirm-actions \.btn \{([^}]*)\}/)?.[1] ?? "";
    expect(Number(/min-height:\s*(\d+)px/.exec(rule)?.[1])).toBeGreaterThanOrEqual(60);
  });
});
