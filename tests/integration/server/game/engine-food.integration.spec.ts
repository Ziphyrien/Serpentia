import { describe, it } from "vite-plus/test";
import {
  FOOD_ABSORB_DURATION_SECONDS,
  FOOD_RESPAWN_SAFE_DISTANCE,
  FOOD_SIZE,
  eatContactDistance,
} from "$lib/game/food-metrics";
import { snakeBodyRadius, targetSnakeBodyScale } from "$lib/game/snake-motion";
import { GameEngine } from "$lib/server/game/engine";
import { gameConfig } from "../../../fixtures/server/game-config";
import { requireCondition } from "../../../support/assertions";
import {
  approximately,
  requireSnake,
  sourceFrameDistance,
  tickDistance,
} from "../../../support/game-engine";

describe("authoritative game engine: food", () => {
  it("food is consumed and converted into length and score", () => {
    const config = gameConfig();
    const engine = new GameEngine(config, 1, false);
    engine.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });
    const before = requireSnake(engine.snapshot(), "a");
    const foodId = engine.addFood({ x: tickDistance(config), y: 0 }, 9);
    const events = engine.step();
    const snake = requireSnake(engine.snapshot(), "a");
    const consumed = events.consumedFoods.find((event) => event.food.id === foodId);
    requireCondition(consumed !== undefined, "food was not consumed");
    requireCondition(consumed.playerId === "a", "food event lost its consumer");
    requireCondition(consumed.sourceFrame === 1, "food was not consumed on the first source frame");
    approximately(consumed.target.x, sourceFrameDistance(config));
    approximately(consumed.target.y, 0);
    approximately(snake.length, config.initialLength + 9);
    approximately(snake.score, before.score + 9);
  });
  it("ambient food respawns only after its absorb animation", () => {
    const config = gameConfig();
    const engine = new GameEngine(config, 1, false);
    engine.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });
    const source = { x: tickDistance(config), y: 0 };
    const foodId = engine.addFood(source, config.dotFoodValue);
    const consumed = engine.step().consumedFoods;
    requireCondition(
      consumed.some((event) => event.food.id === foodId),
      "ambient food was not consumed",
    );
    requireCondition(engine.snapshot().foods.length === 0, "ambient food replenished immediately");
    const respawnDelayTicks = Math.round(FOOD_ABSORB_DURATION_SECONDS * config.tickRate);
    for (let elapsedTicks = 1; elapsedTicks < respawnDelayTicks; elapsedTicks += 1) {
      engine.step();
      requireCondition(
        engine.snapshot().foods.length === 0,
        "ambient food respawned before the absorb animation ended",
      );
    }
    engine.step();
    const respawned = engine.snapshot().foods.find((food) => food.id === foodId);
    requireCondition(respawned !== undefined, "ambient food did not respawn with the same id");
    requireCondition(
      Math.abs(respawned.position.x - source.x) >= FOOD_RESPAWN_SAFE_DISTANCE &&
        Math.abs(respawned.position.y - source.y) >= FOOD_RESPAWN_SAFE_DISTANCE,
      "ambient food respawned inside the original safe interval",
    );
  });
  it("food contact multiplies the sum of snake and food radii", () => {
    const config = gameConfig();
    const engine = new GameEngine(config, 1, false);
    engine.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });
    const bodyScale = targetSnakeBodyScale(config.initialLength, config.minimumLength);
    const radius = snakeBodyRadius(bodyScale);
    const foodRadius = FOOD_SIZE.dot / 2;
    const legacyContact = radius * config.eatDistanceFactor + foodRadius;
    const originalContact = eatContactDistance(radius, foodRadius, config.eatDistanceFactor);
    const contactDistance = (legacyContact + originalContact) / 2;
    const foodId = engine.addFood(
      { x: sourceFrameDistance(config) + contactDistance, y: 0 },
      config.dotFoodValue,
    );
    const events = engine.step();
    requireCondition(
      events.consumedFoods.some((event) => event.food.id === foodId),
      "food inside the original contact distance was not consumed",
    );
  });
  it("food beside the body is not consumed outside the head contact circle", () => {
    const config = gameConfig();
    const engine = new GameEngine(config, 1, false);
    engine.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });
    const foodId = engine.addFood({ x: -40, y: 0 }, config.dotFoodValue);
    const events = engine.step();
    requireCondition(
      !events.consumedFoods.some((event) => event.food.id === foodId),
      "food touching only the snake body was consumed",
    );
    requireCondition(
      engine.snapshot().foods.some((food) => food.id === foodId),
      "body-near food disappeared without a head collision",
    );
  });
});
