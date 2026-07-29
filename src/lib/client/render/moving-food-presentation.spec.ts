import { describe, expect, it } from "vite-plus/test";
import type { FoodState } from "$lib/protocol";
import { MovingFoodPresentation } from "./moving-food-presentation";

function star(x: number, generation: FoodState["generation"] = 0): FoodState {
  return {
    id: 1,
    position: { x, y: 0 },
    value: 10,
    lengthValue: 10,
    variant: 0,
    generation,
    motion: { directionDegrees: 0, linearFramesRemaining: 100 },
    kind: "ambient",
  };
}

describe("moving food presentation", () => {
  it("follows normal three-unit source-frame motion without lag", () => {
    const presentation = new MovingFoodPresentation();
    expect(presentation.sample([star(0)], 0)[0]?.position.x).toBe(0);
    expect(presentation.sample([star(3)], 1000 / 60)[0]?.position.x).toBeCloseTo(3);
  });

  it("spreads a large authority correction over multiple display frames", () => {
    const presentation = new MovingFoodPresentation();
    presentation.sample([star(0)], 0);

    expect(presentation.sample([star(30)], 1000 / 60)[0]?.position.x).toBeCloseTo(6);
    expect(presentation.sample([star(30)], 1000 / 60)[0]?.position.x).toBeCloseTo(12);
  });

  it("snaps a real respawn generation to its new map position", () => {
    const presentation = new MovingFoodPresentation();
    presentation.sample([star(0)], 0);

    expect(presentation.sample([star(500, 1)], 1000 / 60)[0]?.position.x).toBe(500);
  });

  it("does not smooth static food", () => {
    const presentation = new MovingFoodPresentation();
    const dot: FoodState = { ...star(0), value: 1, lengthValue: 1, motion: undefined };
    const moved = { ...dot, position: { x: 100, y: 0 } };

    expect(presentation.sample([dot], 0)[0]?.position.x).toBe(0);
    expect(presentation.sample([moved], 1000 / 60)[0]?.position.x).toBe(100);
  });
});
