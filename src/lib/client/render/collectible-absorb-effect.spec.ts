import { describe, expect, it } from "vite-plus/test";
import {
  advanceCollectibleAbsorbTrackingState,
  createCollectibleAbsorbState,
  createCollectibleAbsorbTrackingState,
  sampleCollectibleAbsorbState,
} from "./collectible-absorb-effect";

describe("collectible absorb effect", () => {
  it("locks a copied target and completes in the configured source-frame count", () => {
    const target = { x: 12, y: 6 };
    const state = createCollectibleAbsorbState({ x: 0, y: 0 }, target, 100, 3);
    target.x = 120;

    expect(sampleCollectibleAbsorbState(state, 100).position).toEqual({ x: 0, y: 0 });
    expect(sampleCollectibleAbsorbState(state, 101).position).toEqual({ x: 4, y: 2 });
    const final = sampleCollectibleAbsorbState(state, 103);
    expect(final.position).toEqual({ x: 12, y: 6 });
    expect(final.complete).toBe(true);
  });

  it("tracks a moving target and lands on its latest position", () => {
    let state = createCollectibleAbsorbTrackingState({ x: 0, y: 0 }, { x: 3, y: 0 }, 100, 3);
    state = advanceCollectibleAbsorbTrackingState(state, 101, { x: 4, y: 0 }).state;
    state = advanceCollectibleAbsorbTrackingState(state, 102, { x: 8, y: 0 }).state;
    const final = advanceCollectibleAbsorbTrackingState(state, 103, { x: 12, y: 0 });

    expect(final.position).toEqual({ x: 12, y: 0 });
    expect(final.complete).toBe(true);
  });
});
