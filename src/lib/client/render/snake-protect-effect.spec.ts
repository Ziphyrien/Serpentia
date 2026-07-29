import { describe, expect, it } from "vite-plus/test";
import { SNAKE_PROTECT_EFFECT, snakeProtectBounds } from "./snake-protect-effect";

describe("snake protect effect", () => {
  it("returns no geometry for an empty path", () => {
    expect(snakeProtectBounds([])).toBeUndefined();
  });

  it("centers a square on the body bounds and pads its diagonal", () => {
    const bounds = snakeProtectBounds([
      { x: -3, y: 4 },
      { x: 9, y: -1 },
      { x: 2, y: 2 },
    ]);
    const expectedSize =
      SNAKE_PROTECT_EFFECT.boundsScale * 13 +
      SNAKE_PROTECT_EFFECT.paddingBodyWidthCount * SNAKE_PROTECT_EFFECT.baseBodyWidth;

    expect(bounds).toBeDefined();
    expect(bounds?.centerX).toBe(3);
    expect(bounds?.centerY).toBe(1.5);
    expect(bounds?.size).toBeCloseTo(expectedSize, 8);
    expect(bounds?.halfSize).toBeCloseTo(expectedSize / 2, 8);
  });

  it("keeps the fixed padding for a one-point body", () => {
    expect(snakeProtectBounds([{ x: 7, y: 11 }])).toEqual({
      centerX: 7,
      centerY: 11,
      size: 216,
      halfSize: 108,
    });
  });
});
