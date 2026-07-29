import { describe, expect, it } from "vite-plus/test";
import {
  eatContactDistance,
  FOOD_SIZE,
  foodDiameterOf,
  usesEatWreckAudio,
  type FoodRadiusRules,
} from "./food-metrics";

const rules: FoodRadiusRules = { starFoodValue: 10 };

describe("food metrics", () => {
  it("routes only stars and death remains to the eat-wreck sound", () => {
    expect(usesEatWreckAudio({ kind: "ambient", value: 1 }, rules)).toBe(false);
    expect(usesEatWreckAudio({ kind: "ambient", value: 10 }, rules)).toBe(true);
    expect(usesEatWreckAudio({ kind: "boost-remains", value: 1 }, rules)).toBe(false);
    expect(usesEatWreckAudio({ kind: "remains", value: 3 }, rules)).toBe(true);
  });

  it("uses the official dot, star, boost-remains, and death-remains sizes", () => {
    expect(foodDiameterOf({ kind: "ambient", value: 1 }, rules)).toBe(FOOD_SIZE.dot);
    expect(foodDiameterOf({ kind: "ambient", value: 10 }, rules)).toBe(FOOD_SIZE.star);
    expect(foodDiameterOf({ kind: "boost-remains", value: 1 }, rules)).toBe(FOOD_SIZE.boostRemains);
    expect(foodDiameterOf({ kind: "remains", value: 3 }, rules)).toBe(FOOD_SIZE.deadRemains);
    expect(foodDiameterOf({ kind: "remains", value: 30 }, rules)).toBe(FOOD_SIZE.deadRemains * 2);
  });

  it("limits an initial-scale star contact to the first two rendered body distances", () => {
    const contactDistance = eatContactDistance(18, FOOD_SIZE.star / 2, 1.6);
    expect(contactDistance).toBeCloseTo(62.4, 12);
    expect(60.75).toBeLessThan(contactDistance);
    expect(90).toBeGreaterThan(contactDistance);
  });
});
