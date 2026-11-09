import { describe, expect, it } from "vitest";
import { buildCadPrompt, DEVICES, isFitCritical, lookupDevice, mentionsDevice } from "@morphix/cad";

describe("device reference table", () => {
  it("matches the most specific device", () => {
    expect(lookupDevice("iPhone 15 Pro Max case")?.name).toBe("iPhone 15 Pro Max");
    expect(lookupDevice("a case for my iphone 15 pro please")?.name).toBe("iPhone 15 Pro");
    expect(lookupDevice("IPHONE 15 bumper")?.name).toBe("iPhone 15");
    expect(lookupDevice("Samsung Galaxy S24 Ultra stand")?.name).toBe("Galaxy S24 Ultra");
    expect(lookupDevice("galaxy s24+ cover")?.name).toBe("Galaxy S24+");
    expect(lookupDevice("pixel 9 pro xl case")?.name).toBe("Pixel 9 Pro XL");
  });

  it("does not guess devices it does not know", () => {
    expect(lookupDevice("iPhone 17 case with a cool design")).toBeNull();
    expect(lookupDevice("iPhone 150 case")).toBeNull();
    expect(lookupDevice("a gear with 20 teeth")).toBeNull();
  });

  it("has sane, sourced numbers", () => {
    for (const d of DEVICES) {
      expect(d.heightMm).toBeGreaterThan(d.widthMm);
      expect(d.widthMm).toBeGreaterThan(d.depthMm);
      expect(d.heightMm).toBeLessThan(220);
      expect(d.depthMm).toBeGreaterThan(5);
      expect(d.source).toMatch(/\w/);
    }
    expect(new Set(DEVICES.map((d) => d.name)).size).toBe(DEVICES.length);
  });

  it("classifies fit-critical requests", () => {
    expect(isFitCritical("iPhone 17 case")).toBe(true);
    expect(isFitCritical("wall mount for a router")).toBe(true);
    expect(isFitCritical("fidget spinner")).toBe(false);
    expect(mentionsDevice("phone stand")).toBe(true);
    expect(mentionsDevice("pencil holder")).toBe(false);
  });
});

describe("buildCadPrompt", () => {
  it("includes the last failures with their code", () => {
    const p = buildCadPrompt({ description: "gear" }, [
      { attempt: 1, scad: "a();", problem: "p1" },
      { attempt: 2, scad: "b();", problem: "p2" },
      { attempt: 3, scad: "c();", problem: "p3" },
    ]);
    expect(p).not.toContain("a();");
    expect(p).toContain("Attempt 2 problem: p2");
    expect(p).toContain("c();");
  });
});
