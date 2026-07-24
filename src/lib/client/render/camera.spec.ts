import { describe, expect, it } from "vite-plus/test";
import { Camera } from "./camera";

describe("camera", () => {
  it("initializes directly at the controlled head", () => {
    const camera = new Camera();
    camera.update(120, -45, 11, 16.7);
    expect(camera.x).toBe(120);
    expect(camera.y).toBe(-45);
  });

  it("follows a moving head monotonically", () => {
    const camera = new Camera();
    camera.update(0, 0, 11, 16.7);
    let previous = camera.x;
    for (let frame = 0; frame < 20; frame += 1) {
      camera.update(100, 0, 11, 1000 / 60);
      expect(camera.x).toBeGreaterThan(previous);
      expect(camera.x).toBeLessThanOrEqual(100);
      previous = camera.x;
    }
  });

  it("resets directly to a respawn position", () => {
    const camera = new Camera();
    camera.update(100, 50, 11, 16.7);
    camera.update(140, 70, 11, 16.7);
    camera.reset();
    camera.update(-300, 240, 11, 16.7);
    expect(camera.x).toBe(-300);
    expect(camera.y).toBe(240);
  });
});
