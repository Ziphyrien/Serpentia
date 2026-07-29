import { describe, expect, it } from "vite-plus/test";
import {
  GAMEPAD_STICK_ENGAGE_DEAD_ZONE,
  GAMEPAD_STICK_RELEASE_DEAD_ZONE,
  gamepadIntent,
  hasGamepadActivity,
  type GamepadButtonState,
  type GamepadState,
} from "./gamepad-mapping";

function gamepad(
  axes: ReadonlyArray<number>,
  activeButtons: ReadonlyArray<number> = [],
  buttonValues: Readonly<Record<number, number>> = {},
): GamepadState {
  const buttons: Array<GamepadButtonState> = Array.from({ length: 16 }, (_, index) => ({
    pressed: activeButtons.includes(index),
    value: buttonValues[index] ?? 0,
  }));
  return { axes, buttons };
}

describe("gamepad mapping", () => {
  it("maps the standard left stick to screen-space steering angles", () => {
    expect(gamepadIntent(gamepad([1, 0]), false).angle).toBeCloseTo(0, 12);
    expect(gamepadIntent(gamepad([0, 1]), false).angle).toBeCloseTo(Math.PI / 2, 12);
    expect(gamepadIntent(gamepad([-1, 0]), false).angle).toBeCloseTo(Math.PI, 12);
    expect(gamepadIntent(gamepad([0, -1]), false).angle).toBeCloseTo(-Math.PI / 2, 12);
  });

  it("uses separate engage and release dead zones to suppress stick jitter", () => {
    const belowEngage = (GAMEPAD_STICK_ENGAGE_DEAD_ZONE + GAMEPAD_STICK_RELEASE_DEAD_ZONE) / 2;
    expect(gamepadIntent(gamepad([belowEngage, 0]), false)).toMatchObject({
      angle: undefined,
      stickActive: false,
    });
    expect(gamepadIntent(gamepad([belowEngage, 0]), true)).toMatchObject({
      angle: 0,
      stickActive: true,
    });
    expect(gamepadIntent(gamepad([GAMEPAD_STICK_RELEASE_DEAD_ZONE, 0]), true)).toMatchObject({
      angle: undefined,
      stickActive: false,
    });
  });

  it("supports the standard d-pad when no analog direction is active", () => {
    expect(gamepadIntent(gamepad([0, 0], [12]), false).angle).toBeCloseTo(-Math.PI / 2, 12);
    expect(gamepadIntent(gamepad([0, 0], [13, 15]), false).angle).toBeCloseTo(Math.PI / 4, 12);
  });

  it("maps face buttons, shoulders, and analog triggers to boost", () => {
    for (const buttonIndex of [0, 1, 2, 3, 4, 5]) {
      expect(gamepadIntent(gamepad([0, 0], [buttonIndex]), false).boosting).toBe(true);
    }
    expect(gamepadIntent(gamepad([0, 0], [], { 6: 0.75 }), false).boosting).toBe(true);
    expect(gamepadIntent(gamepad([0, 0], [], { 7: 0.75 }), false).boosting).toBe(true);
    expect(gamepadIntent(gamepad([0, 0], [9]), false).boosting).toBe(false);
  });

  it("detects activity used to choose between multiple connected gamepads", () => {
    expect(hasGamepadActivity(gamepad([0, 0]))).toBe(false);
    expect(hasGamepadActivity(gamepad([0.5, 0]))).toBe(true);
    expect(hasGamepadActivity(gamepad([0, 0], [9]))).toBe(true);
  });
});
