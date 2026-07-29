import { describe, expect, it } from "vite-plus/test";
import { RENDER } from "../config";
import { Camera, pixelsPerDesignUnit } from "./camera";

const MINIMUM_LENGTH = 80;

describe("camera zoom", () => {
  it("starts at the initial scale and decays linearly with logical length", () => {
    const camera = new Camera();
    camera.update(0, 0, 0);
    expect(camera.zoom).toBeCloseTo(RENDER.cameraInitScale, 8);

    const span = RENDER.cameraInitScale - RENDER.cameraMinScale;
    camera.update(0, 0, RENDER.cameraScaleMaxLength / 2);
    expect(camera.zoom).toBeCloseTo(RENDER.cameraInitScale - span / 2, 8);
  });

  it("clamps at the minimum scale beyond the scale length", () => {
    const camera = new Camera();
    camera.update(0, 0, RENDER.cameraScaleMaxLength);
    expect(camera.zoom).toBe(RENDER.cameraMinScale);
    camera.update(0, 0, RENDER.cameraScaleMaxLength * 10);
    expect(camera.zoom).toBe(RENDER.cameraMinScale);
  });

  it("follows the head without smoothing", () => {
    const camera = new Camera();
    camera.update(120, -45, MINIMUM_LENGTH);
    expect(camera.x).toBe(120);
    expect(camera.y).toBe(-45);
    camera.update(-300, 240, MINIMUM_LENGTH);
    expect(camera.x).toBe(-300);
    expect(camera.y).toBe(240);
  });
});

describe("fixed-height design resolution", () => {
  it("always derives the design scale from screen height", () => {
    expect(pixelsPerDesignUnit(844, 390)).toBeCloseTo(390 / RENDER.designHeight, 8);
    expect(pixelsPerDesignUnit(2560, 1080)).toBeCloseTo(1080 / RENDER.designHeight, 8);
    expect(pixelsPerDesignUnit(1180, 820)).toBeCloseTo(820 / RENDER.designHeight, 8);
    expect(pixelsPerDesignUnit(1024, 768)).toBeCloseTo(768 / RENDER.designHeight, 8);
  });

  it("keeps vertical world view fixed while aspect ratio changes horizontal view", () => {
    const camera = new Camera();
    camera.update(0, 0, MINIMUM_LENGTH);

    const visibleWorldWidth = (width: number, height: number): number =>
      width / camera.worldScale(width, height);
    const visibleWorldHeight = (width: number, height: number): number =>
      height / camera.worldScale(width, height);

    const phoneHeight = visibleWorldHeight(844, 390);
    expect(visibleWorldHeight(2560, 1080)).toBeCloseTo(phoneHeight, 6);
    expect(visibleWorldHeight(1180, 820)).toBeCloseTo(phoneHeight, 6);
    expect(visibleWorldHeight(1024, 768)).toBeCloseTo(phoneHeight, 6);
    expect(phoneHeight).toBeCloseTo(RENDER.designHeight / camera.zoom, 6);

    const designWorldWidth = RENDER.designWidth / camera.zoom;
    expect(visibleWorldWidth(844, 390)).toBeGreaterThan(designWorldWidth);
    expect(visibleWorldWidth(1180, 820)).toBeLessThan(designWorldWidth);
    expect(visibleWorldWidth(1024, 768)).toBeLessThan(designWorldWidth);
  });

  it("derives view bounds from the same combined scale", () => {
    const camera = new Camera();
    camera.update(100, 50, MINIMUM_LENGTH);
    const bounds = camera.viewBounds(844, 390, 0);
    const scale = camera.worldScale(844, 390);
    expect(bounds.right - bounds.left).toBeCloseTo(844 / scale, 6);
    expect(bounds.bottom - bounds.top).toBeCloseTo(390 / scale, 6);
    expect((bounds.left + bounds.right) / 2).toBeCloseTo(100, 6);
  });
});
