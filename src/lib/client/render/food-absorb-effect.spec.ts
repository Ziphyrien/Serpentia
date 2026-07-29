import { describe, expect, it } from "vite-plus/test";
import {
  FOOD_ABSORB_EFFECT,
  advanceFoodAbsorbTrackingState,
  createFoodAbsorbState,
  createFoodAbsorbTrackingState,
  sampleFoodAbsorbState,
} from "./food-absorb-effect";

const COLLISION_SOURCE_FRAME = 120;

describe("food absorb effect", () => {
  it("copies the collision target and advances by the original fixed floating-point delta", () => {
    const target = { x: 12, y: 6 };
    const state = createFoodAbsorbState({ x: 0, y: 0 }, target, COLLISION_SOURCE_FRAME);
    target.x = 120;

    const first = sampleFoodAbsorbState(state, COLLISION_SOURCE_FRAME + 1);
    expect(first.complete).toBe(false);
    expect(first.position).toEqual({ x: 1, y: 0.5 });
    expect(state.target).toEqual({ x: 12, y: 6 });
  });

  it("holds the source on the collision frame and completes on source frame twelve", () => {
    const state = createFoodAbsorbState({ x: 0, y: 0 }, { x: 12, y: 6 }, COLLISION_SOURCE_FRAME);

    const collisionFrame = sampleFoodAbsorbState(state, COLLISION_SOURCE_FRAME);
    expect(collisionFrame.started).toBe(true);
    expect(collisionFrame.completedSourceFrames).toBe(0);
    expect(collisionFrame.position).toEqual({ x: 0, y: 0 });

    for (let frame = 1; frame < FOOD_ABSORB_EFFECT.sourceFrameCount; frame += 1) {
      const sample = sampleFoodAbsorbState(state, COLLISION_SOURCE_FRAME + frame);
      expect(sample.complete).toBe(false);
      expect(sample.position).toEqual({ x: frame, y: frame / 2 });
    }

    const final = sampleFoodAbsorbState(
      state,
      COLLISION_SOURCE_FRAME + FOOD_ABSORB_EFFECT.sourceFrameCount,
    );
    expect(final.complete).toBe(true);
    expect(final.position).toEqual({ x: 12, y: 6 });
  });

  it("replays JavaScript floating-point additions instead of fixed-point math", () => {
    const state = createFoodAbsorbState({ x: 0, y: 0 }, { x: 10, y: 0 }, COLLISION_SOURCE_FRAME);
    expect(state.delta.x).toBeCloseTo(10 / 12, 12);

    const sample = sampleFoodAbsorbState(state, COLLISION_SOURCE_FRAME + 11);
    expect(sample.position.x).toBeCloseTo((10 / 12) * 11, 12);
  });

  it("tracks a boosting presentation head and reaches its current position on frame twelve", () => {
    let state = createFoodAbsorbTrackingState(
      { x: 41, y: 0 },
      { x: 0, y: 0 },
      COLLISION_SOURCE_FRAME,
    );

    for (let frame = 1; frame <= FOOD_ABSORB_EFFECT.sourceFrameCount; frame += 1) {
      const currentHead = { x: frame * 9, y: frame * 2 };
      const sample = advanceFoodAbsorbTrackingState(
        state,
        COLLISION_SOURCE_FRAME + frame,
        currentHead,
      );
      state = sample.state;
      if (frame === 1) expect(sample.position.x).toBeLessThan(41);
      if (frame === FOOD_ABSORB_EFFECT.sourceFrameCount) {
        expect(sample.complete).toBe(true);
        expect(sample.position.x).toBeCloseTo(currentHead.x);
        expect(sample.position.y).toBeCloseTo(currentHead.y);
      }
    }
  });

  it("does not advance a tracking absorb twice on the same source frame", () => {
    const state = createFoodAbsorbTrackingState(
      { x: 41, y: 0 },
      { x: 0, y: 0 },
      COLLISION_SOURCE_FRAME,
    );
    const first = advanceFoodAbsorbTrackingState(state, COLLISION_SOURCE_FRAME + 1, { x: 9, y: 0 });
    const repeated = advanceFoodAbsorbTrackingState(first.state, COLLISION_SOURCE_FRAME + 1, {
      x: 18,
      y: 0,
    });

    expect(repeated.completedSourceFrames).toBe(1);
    expect(repeated.position).toEqual(first.position);
  });

  it("waits before its presentation collision frame", () => {
    const state = createFoodAbsorbState({ x: 0, y: 0 }, { x: 12, y: 0 }, COLLISION_SOURCE_FRAME);

    const before = sampleFoodAbsorbState(state, COLLISION_SOURCE_FRAME - 4);
    expect(before.started).toBe(false);
    expect(before.position.x).toBe(0);
  });
});
