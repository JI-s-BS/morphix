import { describe, expect, it } from "vitest";
import { canTransition, fitsBuildVolume, scaleForHeight, transition, WorkflowError } from "@morphix/domain";

describe("workflow", () => {
  it("follows the happy path up to approval", () => {
    let s = transition("idea", "generating");
    s = transition(s, "reviewing");
    s = transition(s, "sizing");
    s = transition(s, "validating");
    s = transition(s, "slicing");
    expect(transition(s, "approval")).toBe("approval");
  });

  it("cannot skip validation or approval", () => {
    expect(canTransition("reviewing", "printing")).toBe(false);
    expect(canTransition("sizing", "uploading")).toBe(false);
    expect(() => transition("generating", "printing")).toThrow(WorkflowError);
  });

  it("blocks printer states while controls are disabled", () => {
    expect(() => transition("approval", "uploading", { userApproved: true })).toThrow(/not enabled/);
  });

  it("requires explicit approval even when controls are enabled", () => {
    expect(() => transition("approval", "uploading", { printControlsEnabled: true })).toThrow(/approval/);
    expect(transition("approval", "uploading", { printControlsEnabled: true, userApproved: true })).toBe("uploading");
  });

  it("scales and checks the build volume", () => {
    expect(scaleForHeight(50, 152.4)).toBeCloseTo(3.048);
    expect(fitsBuildVolume({ x: 100, y: 100, z: 152 }, { x: 220, y: 220, z: 220 })).toBe(true);
    expect(fitsBuildVolume({ x: 230, y: 10, z: 10 }, { x: 220, y: 220, z: 220 })).toBe(false);
    expect(() => scaleForHeight(0, 10)).toThrow();
  });
});
