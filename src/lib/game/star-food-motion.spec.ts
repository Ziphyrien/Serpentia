import { describe, expect, it } from "vite-plus/test";
import type { FoodState } from "$lib/protocol";
import { normalGameDegreesToRadians } from "./normal-game-math";
import { predictFoodCollisionPosition, predictFoodPresentationPosition } from "./star-food-motion";

const STAR: FoodState = {
  id: 1,
  position: { x: 0, y: 0 },
  value: 10,
  lengthValue: 10,
  variant: 0,
  generation: 0,
  motion: { directionDegrees: 0, linearFramesRemaining: 10 },
  kind: "ambient",
};

describe("star food collision prediction", () => {
  it("advances a known straight segment at three units per source frame", () => {
    expect(predictFoodCollisionPosition(STAR, 100, 106, 2_432, 21)).toEqual({
      x: 18,
      y: 0,
    });
  });

  it("uses the normal Game 3.14 direction conversion", () => {
    const vertical: FoodState = {
      ...STAR,
      motion: { directionDegrees: 90, linearFramesRemaining: 10 },
    };
    const radians = normalGameDegreesToRadians(90);
    expect(predictFoodCollisionPosition(vertical, 100, 101, 2_432, 21)).toEqual({
      x: Math.cos(radians) * 3,
      y: Math.sin(radians) * 3,
    });
  });

  it("lets static food reuse its authoritative state during presentation", () => {
    const dot: FoodState = { ...STAR, value: 1, lengthValue: 1, motion: undefined };
    expect(predictFoodPresentationPosition(dot, 100, 106, 2_432, 8)).toBeUndefined();
  });

  it("advances smoothly on a fractional presentation source frame", () => {
    expect(predictFoodPresentationPosition(STAR, 100, 105.5, 2_432, 21)).toEqual({
      x: 16.5,
      y: 0,
    });
  });

  it("holds the last certain point instead of jumping back before a random turn", () => {
    const turningSoon: FoodState = {
      ...STAR,
      motion: { directionDegrees: 0, linearFramesRemaining: 2 },
    };
    expect(predictFoodPresentationPosition(turningSoon, 100, 101, 2_432, 21)).toEqual({
      x: 3,
      y: 0,
    });
    expect(predictFoodPresentationPosition(turningSoon, 100, 106, 2_432, 21)).toEqual({
      x: 3,
      y: 0,
    });
  });

  it("holds at the last certain boundary point instead of reverting to the snapshot", () => {
    const towardBoundary: FoodState = { ...STAR, position: { x: 2_400, y: 0 } };
    expect(predictFoodPresentationPosition(towardBoundary, 100, 106, 2_432, 21)).toEqual({
      x: 2_408,
      y: 0,
    });
  });

  it("refuses to predict through the next random direction change", () => {
    expect(predictFoodCollisionPosition(STAR, 100, 110, 2_432, 21)).toBeUndefined();
  });

  it("refuses to predict in the boundary turn zone", () => {
    const nearBoundary: FoodState = { ...STAR, position: { x: 2_409, y: 0 } };
    expect(predictFoodCollisionPosition(nearBoundary, 100, 101, 2_432, 21)).toBeUndefined();
  });

  it("keeps static foods at their authoritative position", () => {
    const dot: FoodState = { ...STAR, value: 1, lengthValue: 1, motion: undefined };
    const position = predictFoodCollisionPosition(dot, 100, 106, 2_432, 8);
    expect(position).toEqual({ x: 0, y: 0 });
    expect(position).toBe(dot.position);
  });
});
