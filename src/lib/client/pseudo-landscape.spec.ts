import { describe, expect, it } from "vitest";
import {
  compensatePseudoLandscapeAngle,
  PSEUDO_LANDSCAPE_ANGLE_OFFSET,
  shouldUsePseudoLandscape,
} from "./pseudo-landscape.svelte";

describe("shouldUsePseudoLandscape", () => {
  it("activates only for portrait touch devices without orientation lock", () => {
    expect(
      shouldUsePseudoLandscape({
        portrait: true,
        coarsePointer: true,
        orientationLockAvailable: false,
      }),
    ).toBe(true);
  });

  it("stays off when the system can lock landscape", () => {
    expect(
      shouldUsePseudoLandscape({
        portrait: true,
        coarsePointer: true,
        orientationLockAvailable: true,
      }),
    ).toBe(false);
  });

  it("stays off in real landscape or with a fine pointer", () => {
    expect(
      shouldUsePseudoLandscape({
        portrait: false,
        coarsePointer: true,
        orientationLockAvailable: false,
      }),
    ).toBe(false);
    expect(
      shouldUsePseudoLandscape({
        portrait: true,
        coarsePointer: false,
        orientationLockAvailable: false,
      }),
    ).toBe(false);
  });
});

describe("compensatePseudoLandscapeAngle", () => {
  it("rotates screen-space directions back into game space when active", () => {
    // 角度按 2π 周期等价比较（补偿函数不归一化，消费端用 sin/cos 无影响）
    const equivalent = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));
    // 画面顺时针转 90° 后，推向屏幕右方（0）等于推向游戏上方（-π/2）
    expect(equivalent(compensatePseudoLandscapeAngle(0, true))).toBeCloseTo(-Math.PI / 2);
    // 推向屏幕下方（π/2）等于推向游戏右方（0）
    expect(equivalent(compensatePseudoLandscapeAngle(Math.PI / 2, true))).toBeCloseTo(0);
  });

  it("leaves angles untouched when inactive", () => {
    expect(compensatePseudoLandscapeAngle(1.23, false)).toBe(1.23);
  });

  it("uses a quarter turn as the offset", () => {
    expect(PSEUDO_LANDSCAPE_ANGLE_OFFSET).toBeCloseTo(-Math.PI / 2);
  });
});
