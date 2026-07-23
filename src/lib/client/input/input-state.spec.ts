import { describe, expect, it } from "vite-plus/test";
import { InputState } from "./input-state";

describe("input state", () => {
  it("notifies subscribers only when an intent value changes", () => {
    const state = new InputState();
    let notifications = 0;
    const unsubscribe = state.subscribe(() => {
      notifications += 1;
    });

    state.angle = 1;
    state.angle = 1;
    state.hasDirection = true;
    state.boosting = true;
    state.boosting = true;
    expect(notifications).toBe(3);

    unsubscribe();
    state.boosting = false;
    expect(notifications).toBe(3);
  });
});
