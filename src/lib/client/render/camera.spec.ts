import { describe, expect, it } from "vite-plus/test";
import { Camera, PositionCorrectionSmoother } from "./camera";

describe("position correction presentation", () => {
  it("keeps the corrected frame at the exact previous position", () => {
    const smoother = new PositionCorrectionSmoother();
    const before = { x: 120, y: -45 };
    const correction = { x: -18, y: 9 };
    const corrected = { x: before.x + correction.x, y: before.y + correction.y };

    smoother.preserveAfterTranslation(correction.x, correction.y);

    expect(corrected.x + smoother.offsetX).toBeCloseTo(before.x, 8);
    expect(corrected.y + smoother.offsetY).toBeCloseTo(before.y, 8);
  });

  it("preserves continuity when another correction arrives during convergence", () => {
    const smoother = new PositionCorrectionSmoother();
    let raw = { x: 100, y: 50 };
    smoother.preserveAfterTranslation(20, -10);
    raw = { x: 120, y: 40 };
    smoother.advance(50);
    const before = { x: raw.x + smoother.offsetX, y: raw.y + smoother.offsetY };

    const correction = { x: -7, y: 4 };
    raw = { x: raw.x + correction.x, y: raw.y + correction.y };
    smoother.preserveAfterTranslation(correction.x, correction.y);

    expect(raw.x + smoother.offsetX).toBeCloseTo(before.x, 8);
    expect(raw.y + smoother.offsetY).toBeCloseTo(before.y, 8);
  });

  it("moves the viewport continuously instead of jumping on correction", () => {
    const camera = new Camera();
    const smoother = new PositionCorrectionSmoother();
    const food = { x: 180, y: 20 };
    let rawHead = { x: 100, y: 20 };
    camera.update(rawHead.x, rawHead.y, 11, 16.7);
    const foodScreenBefore = food.x - camera.x;

    rawHead = { x: 120, y: 20 };
    smoother.preserveAfterTranslation(20, 0);
    const correctedHead = rawHead.x + smoother.offsetX;
    camera.update(correctedHead, rawHead.y + smoother.offsetY, 11, 16.7);
    expect(food.x - camera.x).toBeCloseTo(foodScreenBefore, 8);

    let previousCameraX = camera.x;
    for (let frame = 0; frame < 20; frame += 1) {
      smoother.advance(1000 / 60);
      camera.update(rawHead.x + smoother.offsetX, rawHead.y + smoother.offsetY, 11, 1000 / 60);
      expect(Math.abs(camera.x - previousCameraX)).toBeLessThan(2);
      previousCameraX = camera.x;
    }
    expect(Math.abs(smoother.offsetX)).toBeLessThan(0.02);
  });
});
