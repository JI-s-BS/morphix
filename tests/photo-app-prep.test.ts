import { describe, expect, it } from "vitest";
import { PHOTO_LIMITS } from "@morphix/remote";
import { base64Length, ENCODE_STEPS, fitsBudget, fitWithin, PHONE_PHOTO_LIMITS } from "../apps/remote/src/photoPrep";

describe("phone photo preparation (pure helpers)", () => {
  it("shrinks to at most 1600 px on the long side and never enlarges", () => {
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(0, 600, 1600)).toEqual({ width: 0, height: 0 });
    expect(ENCODE_STEPS[0].maxSide).toBe(1600);
  });
  it("keeps the upload under the Pi's (and Vercel's) request limit", () => {
    expect(base64Length(3)).toBe(4);
    expect(fitsBudget([600_000, 700_000])).toBe(true);
    expect(fitsBudget([900_000, 900_000, 900_000, 900_000])).toBe(false);
    expect(fitsBudget([2_500_000])).toBe(false);
    expect(fitsBudget([])).toBe(false);
    expect(fitsBudget(Array(5).fill(100_000))).toBe(false);
    // The phone's limits must sit inside what the Pi accepts.
    expect(PHONE_PHOTO_LIMITS.maxPhotos).toBe(PHOTO_LIMITS.maxPhotos);
    expect(PHONE_PHOTO_LIMITS.maxPhotoBytes).toBeLessThanOrEqual(PHOTO_LIMITS.maxPhotoBytes);
    expect(PHONE_PHOTO_LIMITS.maxTotalBase64 + 2_000).toBeLessThan(PHOTO_LIMITS.maxBodyBytes);
    expect(PHOTO_LIMITS.maxBodyBytes).toBeLessThan(4_500_000);
  });
});
