import { describe, expect, it } from "vite-plus/test";
import { snakerGlareAlpha } from "./snake-layer";

describe("Snaker glare", () => {
  it("matches the source 20-frame triangle wave", () => {
    const values = Array.from({ length: 21 }, (_, frameIndex) =>
      snakerGlareAlpha(frameIndex, 10, 10),
    );

    expect(values).toEqual([
      1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8,
      0.9, 1,
    ]);
  });

  it("moves the backward phase from head to tail", () => {
    for (let beadIndex = 1; beadIndex <= 10; beadIndex += 1) {
      expect(snakerGlareAlpha(beadIndex, beadIndex, 10)).toBe(0);
    }
  });

  it("repeats without changing its spatial phase", () => {
    expect(snakerGlareAlpha(27, 4, 18)).toBe(snakerGlareAlpha(7, 4, 18));
  });
});
