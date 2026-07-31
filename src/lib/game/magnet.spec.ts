import { describe, expect, it } from "vite-plus/test";
import {
  MAGNET,
  magnetPositionAfterSourceFrames,
  predictMagnetCollisionPosition,
  shouldGenerateMagnetWave,
} from "./magnet";

describe("normal endless magnet schedule", () => {
  it("uses the three fixed waves and gates later repeats on the main snake", () => {
    expect(MAGNET.appearTimesSeconds).toEqual([15, 60, 150]);
    expect(shouldGenerateMagnetWave(15, 80_000)).toBe(true);
    expect(shouldGenerateMagnetWave(60, 80_000)).toBe(true);
    expect(shouldGenerateMagnetWave(150, 80_000)).toBe(true);
    expect(shouldGenerateMagnetWave(300, 49_999)).toBe(true);
    expect(shouldGenerateMagnetWave(300, 50_000)).toBe(false);
    expect(shouldGenerateMagnetWave(301, 80)).toBe(false);
  });
});

describe("normal game magnet movement", () => {
  it("uses the 3.14 radian conversion and thousandth precision each source frame", () => {
    expect(
      magnetPositionAfterSourceFrames(
        { position: { x: 0, y: 0 }, directionDegrees: 90 },
        1,
        2_448,
      ),
    ).toEqual({ x: 0.002, y: 3 });
  });

  it("turns inward when the 70-unit tool rectangle crosses the map border", () => {
    expect(
      magnetPositionAfterSourceFrames(
        { position: { x: -2_430, y: 0 }, directionDegrees: 180 },
        1,
        2_448,
      ),
    ).toEqual({ x: -2_427, y: 0 });
  });

  it("predicts collisions only before the next random direction frame", () => {
    const magnet = {
      position: { x: 0, y: 0 },
      directionDegrees: 0,
      linearFramesRemaining: 6,
    };

    expect(predictMagnetCollisionPosition(magnet, 100, 105, 2_448)).toEqual({ x: 15, y: 0 });
    expect(predictMagnetCollisionPosition(magnet, 100, 106, 2_448)).toBeUndefined();
    expect(predictMagnetCollisionPosition(magnet, 100, 105.5, 2_448)).toBeUndefined();
  });
});
