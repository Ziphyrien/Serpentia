import { describe, expect, it } from "vite-plus/test";
import { MAP_BORDER } from "$lib/game/arena";
import { isStarFood } from "$lib/game/food-metrics";
import { normalGameDegreesToRadians } from "$lib/game/normal-game-math";
import { GameEngine } from "./engine";
import { defaultGameConfig } from "./config";

function requireSnake(engine: GameEngine, id: string) {
  const snake = engine.snapshot().snakes.find((candidate) => candidate.id === id);
  if (snake === undefined) throw new Error(`Missing snake ${id}`);
  return snake;
}

describe("official endless food rules", () => {
  it("populates 1000 dots and 30 stars on integer map coordinates", () => {
    const engine = new GameEngine(defaultGameConfig, 7);
    const foods = engine.snapshot().foods;
    const stars = foods.filter((food) => isStarFood(food, defaultGameConfig));
    const dots = foods.filter((food) => !isStarFood(food, defaultGameConfig));
    const extent = defaultGameConfig.arenaHalfSize - MAP_BORDER;

    expect(dots).toHaveLength(1_000);
    expect(stars).toHaveLength(30);
    expect(dots.every((food) => food.variant >= 0 && food.variant < 7)).toBe(true);
    expect(stars.every((food) => food.variant === 0)).toBe(true);
    for (const food of foods) {
      expect(Number.isInteger(food.position.x)).toBe(true);
      expect(Number.isInteger(food.position.y)).toBe(true);
      expect(food.position.x).toBeGreaterThanOrEqual(-extent);
      expect(food.position.x).toBeLessThan(extent);
      expect(food.position.y).toBeGreaterThanOrEqual(-extent);
      expect(food.position.y).toBeLessThan(extent);
      expect(food.lengthValue).toBe(food.value);
    }
  });

  it("moves a star three units per source frame", () => {
    const engine = new GameEngine(defaultGameConfig, 11, false);
    const id = engine.addFood({ x: 0, y: 0 }, defaultGameConfig.starFoodValue);
    const before = engine.snapshot().foods.find((food) => food.id === id);
    if (before === undefined) throw new Error("Missing star before movement");

    expect(before.generation).toBe(0);
    expect(before.motion).toBeDefined();

    engine.step();
    const after = engine.snapshot().foods.find((food) => food.id === id);
    if (after === undefined) throw new Error("Missing star after movement");
    const directionDegrees = before.motion?.directionDegrees;
    if (directionDegrees === undefined) throw new Error("Missing star direction");
    const radians = normalGameDegreesToRadians(directionDegrees);
    expect(after.position.x - before.position.x).toBeCloseTo(9 * Math.cos(radians), 8);
    expect(after.position.y - before.position.y).toBeCloseTo(9 * Math.sin(radians), 8);
    expect(
      Math.hypot(after.position.x - before.position.x, after.position.y - before.position.y),
    ).toBeCloseTo(9, 8);
    expect(after.motion?.directionDegrees).toBe(before.motion?.directionDegrees);
    expect(after.motion?.linearFramesRemaining).toBe(
      (before.motion?.linearFramesRemaining ?? 0) - 3,
    );
  });

  it("keeps an ambient food id and flips its generation on safe respawn", () => {
    const engine = new GameEngine(defaultGameConfig, 19, false);
    engine.addSnake("self", "Self", { position: { x: 0, y: 0 }, angle: 0 });
    const id = engine.addFood({ x: 0, y: 0 }, defaultGameConfig.starFoodValue);

    const consumed = engine.step().consumedFoods.find((event) => event.food.id === id);
    if (consumed === undefined) throw new Error("Star was not consumed");
    expect(consumed.food.generation).toBe(0);

    for (let tick = 0; tick < 4; tick += 1) engine.step();
    const respawned = engine.snapshot().foods.find((food) => food.id === id);
    if (respawned === undefined) throw new Error("Star did not respawn");
    expect(respawned.generation).toBe(1);
    expect(respawned.motion).toBeDefined();
  });

  it("drops one death remain per official rendered body node", () => {
    const engine = new GameEngine(defaultGameConfig, 3, false);
    engine.addSnake("self", "Self", {
      position: { x: defaultGameConfig.arenaHalfSize - MAP_BORDER, y: 0 },
      angle: 0,
    });

    const events = engine.step();
    expect(events.deaths.some((event) => event.playerId === "self")).toBe(true);
    const remains = engine.snapshot().foods.filter((food) => food.kind === "remains");
    expect(remains).toHaveLength(4);
    const expectedScoreValue =
      (Math.pow(defaultGameConfig.initialLength, defaultGameConfig.remainsScoreExponent) *
        defaultGameConfig.remainsScoreFactor) /
      remains.length;
    expect(remains.every((food) => Math.abs(food.value - expectedScoreValue) < 1e-8)).toBe(true);
    expect(remains.every((food) => food.lengthValue === 3)).toBe(true);
    expect(remains.every((food) => food.variant >= 0 && food.variant < 20)).toBe(true);
  });

  it("uses the final score gain for both length and score in new endless", () => {
    const engine = new GameEngine(defaultGameConfig, 1, false);
    engine.addSnake("self", "Self", { position: { x: 0, y: 0 }, angle: 0 });
    const before = requireSnake(engine, "self");
    const value = 16.651_064_148_037_467;
    const id = engine.addFood({ x: 4, y: 0 }, value, "remains", 3);

    const events = engine.step();
    const consumed = events.consumedFoods.find((event) => event.food.id === id);
    if (consumed === undefined) throw new Error("Death remains was not consumed");
    const after = requireSnake(engine, "self");
    const expected = Math.round(before.score + value);

    // WRECK_DEAD_LENGTH=3 仍是残骸对象元数据，但 actAsEndless() 忽略它。
    expect(consumed.food.lengthValue).toBe(3);
    expect(after.score).toBe(expected);
    expect(after.length).toBe(expected);
  });

  it("caps physical body points without clamping logical length or score", () => {
    const engine = new GameEngine(defaultGameConfig, 1, false);
    engine.addSnake("self", "Self", {
      position: { x: 0, y: 0 },
      angle: 0,
      length: defaultGameConfig.maximumLength,
    });
    const before = requireSnake(engine, "self");
    const id = engine.addFood({ x: 4, y: 0 }, 10, "remains", 3);

    const consumed = engine.step().consumedFoods.find((event) => event.food.id === id);
    if (consumed === undefined) throw new Error("Wreck was not consumed");
    const after = requireSnake(engine, "self");

    expect(after.length).toBe(defaultGameConfig.maximumLength + 10);
    expect(after.score).toBe(defaultGameConfig.maximumLength + 10);
    expect(after.body).toHaveLength(before.body.length);
    expect(after.bodyScale).toBe(2.8);
  });
});
