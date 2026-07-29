import { describe, expect, it } from "vite-plus/test";
import { InputState } from "./input-state";

describe("input state", () => {
  it("notifies subscribers only when the resolved intent changes", () => {
    const state = new InputState();
    let notifications = 0;
    const unsubscribe = state.subscribe(() => {
      notifications += 1;
    });

    state.setDirection("pointer", 1);
    state.setDirection("pointer", 1);
    state.setDirection("gamepad", 1);
    state.setBoosting("pointer", true);
    state.setBoosting("keyboard", true);
    state.setBoosting("pointer", false);
    state.setBoosting("keyboard", false);

    expect(notifications).toBe(3);
    expect(state.angle).toBe(1);
    expect(state.hasDirection).toBe(true);
    expect(state.activeDirectionSource).toBe("gamepad");
    expect(state.boosting).toBe(false);

    unsubscribe();
    state.setBoosting("touch", true);
    expect(notifications).toBe(3);
  });

  it("keeps boosting while any input source remains active", () => {
    const state = new InputState();
    state.setBoosting("touch", true);
    state.setBoosting("gamepad", true);
    state.setBoosting("touch", false);
    expect(state.boosting).toBe(true);

    state.setBoosting("gamepad", false);
    expect(state.boosting).toBe(false);
  });

  it("releases one device without erasing its last steering angle", () => {
    const state = new InputState();
    state.setDirection("gamepad", Math.PI / 2);
    state.setBoosting("gamepad", true);
    state.releaseDirection("gamepad");
    state.setBoosting("gamepad", false);

    expect(state.angle).toBe(Math.PI / 2);
    expect(state.hasDirection).toBe(true);
    expect(state.activeDirectionSource).toBeUndefined();
    expect(state.boosting).toBe(false);
  });
});
