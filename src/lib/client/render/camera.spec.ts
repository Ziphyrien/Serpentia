import { describe, expect, it } from "vite-plus/test";
import { Camera, PositionCorrectionSmoother } from "./camera";

describe("position correction presentation", () => {
  it("keeps the corrected frame at the exact previous position", () => {
    const smoother = new PositionCorrectionSmoother();
    const before = { x: 120, y: -45 };
    const correction = { x: -18, y: 9 };
    const corrected = { x: before.x + correction.x, y: before.y + correction.y };

    smoother.preserveAfterTranslation(correction.x, correction.y, 0);

    expect(corrected.x + smoother.offsetX).toBeCloseTo(before.x, 8);
    expect(corrected.y + smoother.offsetY).toBeCloseTo(before.y, 8);
  });

  it("preserves continuity when another correction arrives during convergence", () => {
    const smoother = new PositionCorrectionSmoother();
    let raw = { x: 100, y: 50 };
    smoother.preserveAfterTranslation(20, -10, 0);
    raw = { x: 120, y: 40 };
    smoother.sample(50);
    const before = { x: raw.x + smoother.offsetX, y: raw.y + smoother.offsetY };

    const correction = { x: -7, y: 4 };
    raw = { x: raw.x + correction.x, y: raw.y + correction.y };
    smoother.preserveAfterTranslation(correction.x, correction.y, 50);

    expect(raw.x + smoother.offsetX).toBeCloseTo(before.x, 8);
    expect(raw.y + smoother.offsetY).toBeCloseTo(before.y, 8);
  });

  it("starts and ends correction without a velocity step", () => {
    const smoother = new PositionCorrectionSmoother();
    smoother.preserveAfterTranslation(20, 0, 0);
    const start = smoother.offsetX;
    smoother.sample(1);
    const afterStart = smoother.offsetX;
    smoother.sample(159);
    const beforeEnd = smoother.offsetX;
    smoother.sample(160);
    const end = smoother.offsetX;

    expect(Math.abs(afterStart - start)).toBeLessThan(0.001);
    expect(Math.abs(end - beforeEnd)).toBeLessThan(0.001);
    expect(end).toBe(0);
  });

  it("moves the viewport continuously instead of jumping on correction", () => {
    const camera = new Camera();
    const smoother = new PositionCorrectionSmoother();
    const food = { x: 180, y: 20 };
    let rawHead = { x: 100, y: 20 };
    camera.update(rawHead.x, rawHead.y, 11, 16.7);
    const foodScreenBefore = food.x - camera.x;

    rawHead = { x: 120, y: 20 };
    smoother.preserveAfterTranslation(20, 0, 0);
    const correctedHead = rawHead.x + smoother.offsetX;
    camera.update(correctedHead, rawHead.y + smoother.offsetY, 11, 16.7);
    expect(food.x - camera.x).toBeCloseTo(foodScreenBefore, 8);

    let previousCameraX = camera.x;
    for (let frame = 0; frame < 20; frame += 1) {
      smoother.sample(((frame + 1) * 1000) / 60);
      camera.update(rawHead.x + smoother.offsetX, rawHead.y + smoother.offsetY, 11, 1000 / 60);
      expect(Math.abs(camera.x - previousCameraX)).toBeLessThan(2);
      previousCameraX = camera.x;
    }
    expect(smoother.offsetX).toBe(0);
  });
});
