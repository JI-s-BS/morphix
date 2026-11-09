import { describe, expect, it } from "vitest";
import { remainingSeconds } from "@morphix/printer";

describe("time left on the Printer page", () => {
  it("uses the slicer estimate while heating and in the first layers", () => {
    expect(remainingSeconds(0, 120, 3600)).toBe(3600);
    expect(remainingSeconds(4, 600, 3600)).toBe(Math.round(3600 * 0.96));
  });

  it("moves to the real pace as the print goes on", () => {
    // 50 % done after 40 min: the printer is faster than the 2 h estimate → about 40 min left.
    expect(remainingSeconds(50, 2400, 7200)).toBe(2400);
    // halfway between: a blend of both
    const mid = remainingSeconds(20, 1200, 3600)!;
    expect(mid).toBeGreaterThan(Math.min(3600 * 0.8, 1200 * 4));
    expect(mid).toBeLessThan(Math.max(3600 * 0.8, 1200 * 4));
  });

  it("handles missing information and the end", () => {
    expect(remainingSeconds(10, null, null)).toBeNull();
    expect(remainingSeconds(10, 600, null)).toBe(5400); // pace only
    expect(remainingSeconds(10, null, 3600)).toBe(3240); // estimate only (e.g. after an app restart)
    expect(remainingSeconds(100, 600, 3600)).toBe(0);
  });
});
