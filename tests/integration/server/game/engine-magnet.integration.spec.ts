import { describe, expect, it } from "vite-plus/test";
import { MAGNET } from "$lib/game/magnet";
import { eatContactDistance, FOOD_SIZE } from "$lib/game/food-metrics";
import { snakeBodyRadius } from "$lib/game/snake-motion";
import { GameEngine } from "$lib/server/game/engine";
import { SOURCE_FRAME_RATE } from "$lib/server/game/config";
import { gameConfig } from "../../../fixtures/server/game-config";
import { requireSnake, sourceFrameDistance } from "../../../support/game-engine";

function pickupMagnet(engine: GameEngine): number {
  const before = requireSnake(engine.snapshot(), "self");
  const id = engine.addMagnet({
    x: before.body[0].x + sourceFrameDistance(engine.config),
    y: before.body[0].y,
  });
  const event = engine.step().consumedMagnets?.find((consumed) => consumed.magnet.id === id);
  expect(event).toBeDefined();
  if (event === undefined) throw new Error("magnet was not consumed");
  return event.sourceFrame;
}

describe("authoritative game engine: normal new-endless magnet", () => {
  it("uses the new-endless 10-item schedule and 20-second existence", () => {
    const config = gameConfig({ arenaHalfSize: 100_000 });
    const engine = new GameEngine(config, 19, false);
    engine.addSnake("self", "Self", { position: { x: 0, y: 0 }, angle: 0 });

    for (let tick = 0; tick < 15 * config.tickRate; tick += 1) engine.step();
    expect(engine.snapshot().magnets).toHaveLength(MAGNET.countPerWave);
    for (let tick = 0; tick < MAGNET.existSeconds * config.tickRate; tick += 1) engine.step();
    expect(engine.snapshot().magnets).toEqual([]);
  });

  it("does not let an active magnet pull another magnet", () => {
    const config = gameConfig();
    const engine = new GameEngine(config, 5, false);
    engine.addSnake("self", "Self", { position: { x: 0, y: 0 }, angle: 0 });
    pickupMagnet(engine);
    const snake = requireSnake(engine.snapshot(), "self");
    const bodyRadius = snakeBodyRadius(snake.bodyScale);
    const baseToolContact = (bodyRadius + MAGNET.toolSize / 2) * config.eatDistanceFactor;
    const id = engine.addMagnet({
      x: snake.body[0].x + baseToolContact + MAGNET.extraEatScope / 2,
      y: snake.body[0].y,
    });

    const events = engine.step();
    expect(events.consumedMagnets?.some((event) => event.magnet.id === id)).toBe(false);
    expect(engine.snapshot().magnets?.some((magnet) => magnet.id === id)).toBe(true);
  });

  it("adds exactly 86.4 to food reach and resets repeated pickup to eight seconds", () => {
    const config = gameConfig();
    const engine = new GameEngine(config, 8, false);
    engine.addSnake("self", "Self", { position: { x: 0, y: 0 }, angle: 0 });
    pickupMagnet(engine);
    const snake = requireSnake(engine.snapshot(), "self");
    const baseContact = eatContactDistance(
      snakeBodyRadius(snake.bodyScale),
      FOOD_SIZE.dot / 2,
      config.eatDistanceFactor,
    );
    const foodId = engine.addFood(
      {
        x: snake.body[0].x + sourceFrameDistance(config) + baseContact + 40,
        y: snake.body[0].y,
      },
      config.dotFoodValue,
    );
    expect(engine.step().consumedFoods.some((event) => event.food.id === foodId)).toBe(true);

    for (let tick = 0; tick < config.tickRate; tick += 1) engine.step();
    const refreshedAtSourceFrame = pickupMagnet(engine);
    const refreshed = requireSnake(engine.snapshot(), "self");
    const deadline = refreshedAtSourceFrame + config.magnetDurationSourceFrames;
    expect(refreshed.magnetUntilSourceFrame).toBe(deadline);
    const sourceFramesPerTick = SOURCE_FRAME_RATE / config.tickRate;
    const ticksUntilExpiry = Math.ceil(
      (deadline - engine.tick * sourceFramesPerTick) / sourceFramesPerTick,
    );
    for (let tick = 1; tick < ticksUntilExpiry; tick += 1) engine.step();
    expect(requireSnake(engine.snapshot(), "self").magnetUntilSourceFrame).toBe(deadline);
    engine.step();
    expect(requireSnake(engine.snapshot(), "self").magnetUntilSourceFrame).toBeNull();
  });

  it("keeps absolute state through death and restores its presentation on respawn", () => {
    const config = gameConfig({ respawnDelayTicks: 2, arenaHalfSize: 1_000 });
    const engine = new GameEngine(config, 11, false);
    engine.addSnake("self", "Self", { position: { x: 0, y: 0 }, angle: 0 });
    pickupMagnet(engine);
    const head = requireSnake(engine.snapshot(), "self").body[0];
    engine.addSnake("wall", "Wall", {
      body: [
        { x: head.x + 5, y: head.y - 80 },
        { x: head.x + 5, y: head.y + 80 },
      ],
      angle: Math.PI / 2,
    });
    engine.step();
    const dead = requireSnake(engine.snapshot(), "self");
    expect(dead.alive).toBe(false);
    expect(dead.magnetUntilSourceFrame).not.toBeNull();

    engine.step();
    engine.step();
    const respawned = requireSnake(engine.snapshot(), "self");
    expect(respawned.alive).toBe(true);
    expect(respawned.magnetUntilSourceFrame).not.toBeNull();
  });
});
