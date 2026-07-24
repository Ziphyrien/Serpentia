import { describe, expect, it } from "vite-plus/test";
import { directionAngleFromJoystickVector } from "./joystick-vector";

describe("joystick direction", () => {
  it("keeps a centered press neutral instead of converting it to east", () => {
    expect(directionAngleFromJoystickVector({ x: 0, y: 0 })).toBeUndefined();
    expect(directionAngleFromJoystickVector({ x: 0.08, y: -0.08 })).toBeUndefined();
  });

  it("converts vectors outside the dead zone to game-space angles", () => {
    expect(directionAngleFromJoystickVector({ x: 1, y: 0 })).toBeCloseTo(0);
    expect(directionAngleFromJoystickVector({ x: 0, y: 1 })).toBeCloseTo(-Math.PI / 2);
    expect(directionAngleFromJoystickVector({ x: 0, y: -1 })).toBeCloseTo(Math.PI / 2);
  });
});
