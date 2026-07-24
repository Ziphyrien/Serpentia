import { describe, expect, it } from "vite-plus/test";
import { Camera } from "./camera";

describe("camera position correction", () => {
  it("preserves the controlled head's screen position when authority translates it", () => {
    const camera = new Camera();
    let head = { x: 120, y: -45 };
    camera.update(head.x, head.y, 11, 16.7);
    const before = { x: head.x - camera.x, y: head.y - camera.y };

    const correction = { x: -18, y: 9 };
    head = { x: head.x + correction.x, y: head.y + correction.y };
    camera.compensatePositionCorrection(correction.x, correction.y);

    expect(head.x - camera.x).toBeCloseTo(before.x, 8);
    expect(head.y - camera.y).toBeCloseTo(before.y, 8);
  });
});
