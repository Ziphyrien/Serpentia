import { describe, expect, it } from "vite-plus/test";
import { normalGameDegreesToRadians } from "$lib/game/normal-game-math";
import {
  DECORATIVE_STAR_MOVE_DISTANCE_PER_SOURCE_FRAME,
  advanceDecorativeStarSourceFrame,
  clampDecorativeStarToBounds,
  randomDecorativeStarLinearFrames,
} from "./decorative-star-motion";

const BOUNDS = { width: 100, height: 80, radius: 10 };

describe("decorative star motion", () => {
  it("moves in a constant straight segment at the homepage-scaled speed", () => {
    expect(
      advanceDecorativeStarSourceFrame(
        { x: 50, y: 40, directionDegrees: 0, linearFramesRemaining: 50 },
        BOUNDS,
        90,
        150,
      ),
    ).toEqual({
      x: 50 + DECORATIVE_STAR_MOVE_DISTANCE_PER_SOURCE_FRAME,
      y: 40,
      directionDegrees: 0,
      linearFramesRemaining: 49,
    });
  });

  it("changes direction when the original 100–199 frame segment expires", () => {
    const radians = normalGameDegreesToRadians(90);
    expect(
      advanceDecorativeStarSourceFrame(
        { x: 50, y: 40, directionDegrees: 0, linearFramesRemaining: 1 },
        BOUNDS,
        90,
        150,
      ),
    ).toEqual({
      x: 50 + Math.cos(radians) * DECORATIVE_STAR_MOVE_DISTANCE_PER_SOURCE_FRAME,
      y: 40 + Math.sin(radians) * DECORATIVE_STAR_MOVE_DISTANCE_PER_SOURCE_FRAME,
      directionDegrees: 90,
      linearFramesRemaining: 150,
    });
  });

  it("turns inward after crossing each field edge", () => {
    expect(
      advanceDecorativeStarSourceFrame(
        { x: 9, y: 40, directionDegrees: 180, linearFramesRemaining: 50 },
        BOUNDS,
        45,
        120,
      ).directionDegrees,
    ).toBe(0);
    expect(
      advanceDecorativeStarSourceFrame(
        { x: 50, y: 71, directionDegrees: 90, linearFramesRemaining: 50 },
        BOUNDS,
        45,
        120,
      ).directionDegrees,
    ).toBe(270);
    expect(
      advanceDecorativeStarSourceFrame(
        { x: 91, y: 40, directionDegrees: 0, linearFramesRemaining: 50 },
        BOUNDS,
        45,
        120,
      ).directionDegrees,
    ).toBe(180);
    expect(
      advanceDecorativeStarSourceFrame(
        { x: 50, y: 9, directionDegrees: 270, linearFramesRemaining: 50 },
        BOUNDS,
        45,
        120,
      ).directionDegrees,
    ).toBe(90);
  });

  it("keeps the star inside a resized field", () => {
    expect(
      clampDecorativeStarToBounds(
        { x: 120, y: -20, directionDegrees: 0, linearFramesRemaining: 100 },
        BOUNDS,
      ),
    ).toEqual({ x: 90, y: 10, directionDegrees: 0, linearFramesRemaining: 100 });
  });

  it("uses the same 100–199 frame random range as gameplay", () => {
    expect(randomDecorativeStarLinearFrames(0)).toBe(100);
    expect(randomDecorativeStarLinearFrames(0.999999)).toBe(199);
    expect(randomDecorativeStarLinearFrames(1)).toBe(199);
  });
});
