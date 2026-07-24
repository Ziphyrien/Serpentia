import { describe, expect, it } from "vite-plus/test";
import type { FoodState } from "$lib/protocol";
import { FoodSpeculation, type FoodSpeculationFrame } from "./food-speculation";

function food(id = 1, x = 0): FoodState {
  return { id, position: { x, y: 0 }, value: 1, kind: "ambient" };
}

function frame(overrides: Partial<FoodSpeculationFrame> = {}): FoodSpeculationFrame {
  return {
    foods: [food()],
    authoritativeTick: 10,
    predictedTick: 12,
    head: { x: 15, y: 0 },
    snakeRadius: 10,
    foodRadius: 5,
    alive: true,
    ...overrides,
  };
}

describe("food speculation", () => {
  it("hides an exact predicted collision without expanding its radius", () => {
    const inside = new FoodSpeculation();
    expect(inside.update(frame()).has(1)).toBe(true);
    const outside = new FoodSpeculation();
    expect(outside.update(frame({ head: { x: 15.001, y: 0 } })).has(1)).toBe(false);
  });

  it("uses the authoritative tick endpoint instead of an interpolated crossing", () => {
    const speculation = new FoodSpeculation();
    expect(
      speculation
        .update(
          frame({
            head: { x: 0, y: 0 },
            predictedHeadAtTick: () => ({ x: 15.001, y: 0 }),
          }),
        )
        .has(1),
    ).toBe(false);
  });

  it("restores immediately when rollback moves the predicted tick away", () => {
    const speculation = new FoodSpeculation();
    speculation.update(frame({ predictedHeadAtTick: () => ({ x: 15, y: 0 }) }));
    expect(
      speculation
        .update(
          frame({
            authoritativeTick: 11,
            predictedHeadAtTick: () => ({ x: 30, y: 0 }),
          }),
        )
        .has(1),
    ).toBe(false);
  });

  it("keeps food hidden until authority reaches the predicted collision tick", () => {
    const speculation = new FoodSpeculation();
    speculation.update(frame());
    expect(speculation.update(frame({ authoritativeTick: 11 })).has(1)).toBe(true);
    expect(speculation.update(frame({ authoritativeTick: 12 })).has(1)).toBe(false);
  });

  it("restores a rejected prediction and waits for the head to leave", () => {
    const speculation = new FoodSpeculation();
    speculation.update(frame());
    expect(speculation.update(frame({ authoritativeTick: 12 })).has(1)).toBe(false);
    expect(speculation.update(frame({ authoritativeTick: 13, predictedTick: 14 })).has(1)).toBe(
      false,
    );

    speculation.update(frame({ authoritativeTick: 13, predictedTick: 14, head: { x: 30, y: 0 } }));
    expect(speculation.update(frame({ authoritativeTick: 13, predictedTick: 15 })).has(1)).toBe(
      true,
    );
  });

  it("clears confirmed and death-phase predictions", () => {
    const speculation = new FoodSpeculation();
    speculation.update(frame());
    expect(speculation.update(frame({ foods: [] })).size).toBe(0);

    speculation.update(frame());
    expect(speculation.update(frame({ alive: false })).size).toBe(0);
  });
});
