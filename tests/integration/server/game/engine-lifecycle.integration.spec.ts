import { describe, it } from "vite-plus/test";
import { borderCollisionDistance } from "$lib/game/arena";
import { NORMAL_GAME_PI } from "$lib/game/normal-game-math";
import { SNAKE_MOTION, snakeBodyRadius, targetSnakeBodyScale } from "$lib/game/snake-motion";
import { GameEngine } from "$lib/server/game/engine";
import { gameConfig } from "../../../fixtures/server/game-config";
import { requireCondition } from "../../../support/assertions";
import { approximately, requireSnake } from "../../../support/game-engine";

interface HeadContactSnake {
  readonly id: string;
  readonly angle: number;
  readonly targetHeadX: number;
}

function addSnakeMeetingAt(engine: GameEngine, snake: HeadContactSnake): void {
  const moveDistance = SNAKE_MOTION.pointsPerFrame * SNAKE_MOTION.pointSpacing;
  const cosine = Math.cos(snake.angle);
  const sine = Math.sin(snake.angle);
  const head = {
    x: snake.targetHeadX - moveDistance * cosine,
    y: -moveDistance * sine,
  };
  engine.addSnake(snake.id, snake.id, {
    angle: snake.angle,
    body: [
      head,
      {
        x: head.x - SNAKE_MOTION.pointSpacing * cosine,
        y: head.y - SNAKE_MOTION.pointSpacing * sine,
      },
    ],
  });
}

describe("authoritative game engine: lifecycle", () => {
  it("identical seeds produce deterministic initial worlds", () => {
    const config = gameConfig({ dotFoodTarget: 32, starFoodTarget: 4 });
    const left = new GameEngine(config, 7);
    const right = new GameEngine(config, 7);
    left.addSnake("a", "Alpha");
    right.addSnake("a", "Alpha");
    requireCondition(
      JSON.stringify(left.snapshot()) === JSON.stringify(right.snapshot()),
      "seeded worlds diverged",
    );
  });
  it("does not expose a zero-duration protection frame", () => {
    const engine = new GameEngine(gameConfig(), 1, false);
    engine.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });

    requireCondition(
      !requireSnake(engine.snapshot(), "a").invulnerable,
      "zero-duration protection appeared in the spawn snapshot",
    );
  });
  it("expires configured protection on its final 60 Hz source frame", () => {
    const engine = new GameEngine(gameConfig(), 1, false);
    engine.addSnake("a", "Alpha", {
      position: { x: 0, y: 0 },
      angle: 0,
      invulnerabilityTicks: 3,
    });

    requireCondition(requireSnake(engine.snapshot(), "a").invulnerable, "protection was missing");
    engine.step();
    requireCondition(
      requireSnake(engine.snapshot(), "a").invulnerable,
      "protection ended during its first tick",
    );
    engine.step();
    requireCondition(
      requireSnake(engine.snapshot(), "a").invulnerable,
      "protection ended before its final source frame",
    );
    engine.step();
    requireCondition(
      !requireSnake(engine.snapshot(), "a").invulnerable,
      "protection remained after its final source frame",
    );
  });
  it("a snake may safely coil across its own body", () => {
    const engine = new GameEngine(gameConfig(), 1, false);
    engine.addSnake("a", "Alpha", {
      angle: 0,
      body: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
        { x: 0, y: 0 },
      ],
    });
    engine.step();
    requireCondition(requireSnake(engine.snapshot(), "a").alive, "self collision killed snake");
  });
  it("crossing the arena wall kills the snake", () => {
    const config = gameConfig({ arenaHalfSize: 100 });
    const engine = new GameEngine(config, 1, false);
    engine.addSnake("a", "Alpha", { position: { x: 82, y: 0 }, angle: 0 });
    const events = engine.step();
    requireCondition(events.deaths.length === 1, "boundary death missing");
    requireCondition(events.deaths[0].cause._tag === "Boundary", "wrong death cause");
    requireCondition(!requireSnake(engine.snapshot(), "a").alive, "snake remained alive");
  });
  it("enemy body collision awards a kill and creates contested remains", () => {
    const engine = new GameEngine(gameConfig(), 1, false);
    engine.addSnake("attacker", "Attacker", {
      angle: Math.PI / 2,
      body: [
        { x: 10, y: -30 },
        { x: 10, y: 30 },
      ],
    });
    engine.addSnake("victim", "Victim", { position: { x: 0, y: 0 }, angle: 0 });
    const events = engine.step();
    const snapshot = engine.snapshot();
    requireCondition(
      events.deaths.some((event) => event.playerId === "victim"),
      "victim survived",
    );
    requireCondition(requireSnake(snapshot, "attacker").kills === 1, "kill was not awarded");
    requireCondition(
      snapshot.foods.some((food) => food.kind === "remains") ||
        events.consumedFoods.some((event) => event.food.kind === "remains"),
      "remains were neither left in the arena nor consumed on a later source frame",
    );
  });
  it("head-on contact kills exactly one snake using the original direction comparison", () => {
    const config = gameConfig({ tickRate: 60, arenaHalfSize: 1_000 });
    const cases = [
      {
        alphaAngle: 0,
        bravoAngle: (NORMAL_GAME_PI * 2) / 3,
        alphaHeadX: -8,
        bravoHeadX: 8,
        expectedVictim: "alpha",
      },
      {
        alphaAngle: 0,
        bravoAngle: NORMAL_GAME_PI,
        alphaHeadX: 0,
        bravoHeadX: 0,
        expectedVictim: "alpha",
      },
      {
        alphaAngle: NORMAL_GAME_PI,
        bravoAngle: 0,
        alphaHeadX: 0,
        bravoHeadX: 0,
        expectedVictim: "bravo",
      },
    ] as const;

    for (const scenario of cases) {
      const snakes = [
        {
          id: "alpha",
          angle: scenario.alphaAngle,
          targetHeadX: scenario.alphaHeadX,
        },
        {
          id: "bravo",
          angle: scenario.bravoAngle,
          targetHeadX: scenario.bravoHeadX,
        },
      ] as const;
      for (const order of [snakes, snakes.toReversed()]) {
        const engine = new GameEngine(config, 1, false);
        for (const snake of order) addSnakeMeetingAt(engine, snake);

        const events = engine.step();
        const expectedWinner = scenario.expectedVictim === "alpha" ? "bravo" : "alpha";
        requireCondition(events.deaths.length === 1, "head-on contact did not have one victim");
        requireCondition(
          events.deaths[0].playerId === scenario.expectedVictim,
          "head-on direction comparison chose the wrong victim",
        );
        requireCondition(
          events.deaths[0].cause._tag === "Snake" &&
            events.deaths[0].cause.killerId === expectedWinner,
          "head-on death did not credit the survivor",
        );
        requireCondition(
          requireSnake(engine.snapshot(), expectedWinner).alive,
          "head-on winner did not survive",
        );
        requireCondition(
          requireSnake(engine.snapshot(), expectedWinner).kills === 1,
          "head-on winner was not credited with one kill",
        );
      }
    }
  });
  it("death is followed by fast protected respawn", () => {
    const config = gameConfig({
      arenaHalfSize: 600,
      spawnClearance: 120,
      respawnDelayTicks: 2,
      respawnInvulnerabilityTicks: 3,
    });
    const engine = new GameEngine(config, 4, false);
    const bodyScale = targetSnakeBodyScale(config.initialLength, config.minimumLength);
    const radius = snakeBodyRadius(bodyScale);
    engine.addSnake("a", "Alpha", {
      position: {
        x: config.arenaHalfSize - borderCollisionDistance(radius),
        y: 0,
      },
      angle: 0,
    });
    engine.step();
    engine.step();
    const events = engine.step();
    const snake = requireSnake(engine.snapshot(), "a");
    requireCondition(events.respawnedPlayerIds.includes("a"), "respawn event missing");
    requireCondition(snake.alive, "snake did not respawn");
    requireCondition(snake.invulnerable, "respawn was not protected");
    approximately(snake.length, config.initialLength);

    engine.step();
    requireCondition(
      requireSnake(engine.snapshot(), "a").invulnerable,
      "respawn protection ended before its final tick",
    );
    engine.step();
    requireCondition(
      !requireSnake(engine.snapshot(), "a").invulnerable,
      "respawn protection remained after its final source frame",
    );
  });
});
