import { describe, expect, it } from "vite-plus/test";
import {
  sampleSnakeMagnetLight,
  sampleSnakeMagnetParticle,
  sampleSnakeMagnetRing,
} from "./snake-magnet-effect";

describe("snake magnet prefab animation", () => {
  it("samples the 20-frame looping light curves at their authored keyframes", () => {
    expect(sampleSnakeMagnetLight(0, 1)).toMatchObject({
      x: 77.376,
      y: 120.311,
      alpha: 0,
      scale: 0.5625,
    });
    expect(sampleSnakeMagnetLight(1, 6)).toMatchObject({
      x: -17.406,
      y: 22.302,
      alpha: 0,
      scale: 0.5,
    });
    expect(sampleSnakeMagnetLight(4, 9)).toMatchObject({
      x: -109.642,
      y: 51.679,
      alpha: 0,
    });
    expect(sampleSnakeMagnetLight(0, 21)).toEqual(sampleSnakeMagnetLight(0, 1));
  });

  it("uses both authored radial pulses and the particle emitter cadence", () => {
    expect(sampleSnakeMagnetRing(0, 1)).toMatchObject({ alpha: 0, scale: 5 });
    expect(sampleSnakeMagnetRing(1, 11)).toMatchObject({ alpha: 0, scale: 5 });
    expect(sampleSnakeMagnetParticle(0).visible).toBe(false);
    expect(sampleSnakeMagnetParticle(12)).toMatchObject({ visible: true });
    expect(sampleSnakeMagnetParticle(12).x).toBeGreaterThanOrEqual(-33);
    expect(sampleSnakeMagnetParticle(12).x).toBeLessThanOrEqual(-31);
    expect(sampleSnakeMagnetParticle(18).visible).toBe(false);
    expect(sampleSnakeMagnetParticle(24).visible).toBe(true);
  });
});
