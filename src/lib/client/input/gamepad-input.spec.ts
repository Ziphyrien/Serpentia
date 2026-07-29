import { describe, expect, it } from "vite-plus/test";
import { playDeathRumble, type HapticGamepad } from "./gamepad-input";

describe("gamepad haptics", () => {
  it("plays one strong dual-rumble effect for local death", async () => {
    const calls: Array<{
      readonly type: GamepadHapticEffectType;
      readonly parameters: GamepadEffectParameters | undefined;
    }> = [];
    const gamepad: HapticGamepad = {
      vibrationActuator: {
        playEffect(type, parameters) {
          calls.push({ type, parameters });
          return Promise.resolve("complete");
        },
      },
    };

    await playDeathRumble(gamepad);

    expect(calls).toEqual([
      {
        type: "dual-rumble",
        parameters: {
          duration: 420,
          startDelay: 0,
          strongMagnitude: 1,
          weakMagnitude: 0.55,
        },
      },
    ]);
  });

  it("silently skips controllers without haptic hardware", async () => {
    await expect(playDeathRumble({})).resolves.toBeUndefined();
  });

  it("contains browser haptic failures", async () => {
    const gamepad: HapticGamepad = {
      vibrationActuator: {
        playEffect() {
          return Promise.reject(new Error("haptics unavailable"));
        },
      },
    };

    await expect(playDeathRumble(gamepad)).resolves.toBeUndefined();
  });
});
