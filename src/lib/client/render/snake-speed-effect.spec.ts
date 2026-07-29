import { describe, expect, it } from "vite-plus/test";
import {
  SNAKE_SPEED_EFFECT,
  accumulateSpeedSourceFrame,
  advanceSpeedPointIndex,
  forEachSpeedPathSample,
  speedPeriodPointCount,
  updateSpeedAnimationState,
  type SpeedAnimationState,
} from "./snake-speed-effect";

describe("snake speed effect", () => {
  it("uses the discrete point period and fixed wrap index", () => {
    expect(speedPeriodPointCount(1)).toBe(58);
    expect(advanceSpeedPointIndex(SNAKE_SPEED_EFFECT.startPointIndex, 1, 1)).toBe(13);
    expect(advanceSpeedPointIndex(57, 1, 1)).toBe(SNAKE_SPEED_EFFECT.startPointIndex);
  });

  it("advances at most one source frame per render update", () => {
    expect(accumulateSpeedSourceFrame(0, 1000 / 120)).toEqual({
      frameCount: 0,
      remainder: 0.5,
    });
    expect(accumulateSpeedSourceFrame(0.5, 1000 / 120).frameCount).toBe(1);
    expect(accumulateSpeedSourceFrame(0.25, 1_000)).toEqual({
      frameCount: 1,
      remainder: 0.25,
    });
  });

  it("advances immediately on activation and resumes from the paused index", () => {
    const initial: SpeedAnimationState = {
      pointIndex: SNAKE_SPEED_EFFECT.startPointIndex,
      frameRemainder: 0,
      wasBoosting: false,
    };
    const active = updateSpeedAnimationState(initial, true, 1, 0);
    expect(active).toEqual({ pointIndex: 13, frameRemainder: 0, wasBoosting: true });

    const paused = updateSpeedAnimationState(active, false, 1, 1_000);
    expect(paused).toEqual({ pointIndex: 13, frameRemainder: 0, wasBoosting: false });

    const resumed = updateSpeedAnimationState(paused, true, 1, 1_000);
    expect(resumed).toEqual({ pointIndex: 16, frameRemainder: 0, wasBoosting: true });
  });

  it("uses the tail-side segment direction for a sample on a corner", () => {
    const samples: Array<{ x: number; y: number; angle: number }> = [];
    forEachSpeedPathSample(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      10,
      20,
      (x, y, angle) => samples.push({ x, y, angle }),
    );

    expect(samples).toHaveLength(1);
    expect(samples[0].x).toBe(10);
    expect(samples[0].y).toBe(0);
    expect(samples[0].angle).toBeCloseTo(-Math.PI / 2, 8);
  });

  it("samples successive centers by arc length", () => {
    const samples: Array<[number, number]> = [];
    forEachSpeedPathSample(
      [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
      ],
      5,
      10,
      (x, y) => samples.push([x, y]),
    );
    expect(samples).toEqual([
      [5, 0],
      [15, 0],
      [25, 0],
    ]);
  });
});
