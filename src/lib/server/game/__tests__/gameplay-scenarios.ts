import { generateAccessKey, hashAccessKey, identifyAccessKey, normalizeAccessKey } from "../../access/access-key";
import { Effect } from "effect";
import { decodeClientMessage } from "../../protocol/client-message";
import { GameEngine } from "../engine";
import type { GameSnapshot, SnakeSnapshot } from "../model";
import { gameConfig } from "./game-config";

export interface GameplayScenario {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

function requireSnake(snapshot: GameSnapshot, playerId: string): SnakeSnapshot {
  const snake = snapshot.snakes.find((candidate) => candidate.id === playerId);
  if (!snake) throw new Error(`Missing snake ${playerId}`);
  return snake;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function approximately(actual: number, expected: number, tolerance = 0.000_001): void {
  requireCondition(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

export const gameplayScenarios: ReadonlyArray<GameplayScenario> = [
  {
    name: "base movement advances the authoritative head",
    run: () => {
      const config = gameConfig();
      const engine = new GameEngine(config, 1, false);
      engine.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });
      engine.step();
      const snake = requireSnake(engine.snapshot(), "a");
      approximately(snake.body[0].x, config.baseSpeed / config.tickRate);
      approximately(snake.body[0].y, 0);
    },
  },
  {
    name: "turning is capped by the server turn rate",
    run: () => {
      const config = gameConfig();
      const engine = new GameEngine(config, 1, false);
      engine.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });
      engine.step([{ playerId: "a", sequence: 1, angle: Math.PI / 2, boosting: false }]);
      const snake = requireSnake(engine.snapshot(), "a");
      approximately(snake.angle, config.turnRate / config.tickRate);
    },
  },
  {
    name: "food is consumed and converted into length and score",
    run: () => {
      const config = gameConfig();
      const engine = new GameEngine(config, 1, false);
      engine.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });
      const foodId = engine.addFood({ x: config.baseSpeed / config.tickRate, y: 0 }, 9);
      const events = engine.step();
      const snake = requireSnake(engine.snapshot(), "a");
      requireCondition(events.consumedFoodIds.includes(foodId), "food was not consumed");
      approximately(snake.length, config.initialLength + 9);
      approximately(snake.score, 9);
    },
  },
  {
    name: "boost trades body length for tactical speed",
    run: () => {
      const config = gameConfig();
      const normal = new GameEngine(config, 1, false);
      const boosted = new GameEngine(config, 1, false);
      normal.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });
      boosted.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });
      normal.step();
      boosted.step([{ playerId: "a", sequence: 1, angle: 0, boosting: true }]);
      const normalSnake = requireSnake(normal.snapshot(), "a");
      const boostedSnake = requireSnake(boosted.snapshot(), "a");
      requireCondition(boostedSnake.body[0].x > normalSnake.body[0].x, "boost did not add speed");
      requireCondition(boostedSnake.length < normalSnake.length, "boost did not consume length");
    },
  },
  {
    name: "stale client input cannot overwrite newer intent",
    run: () => {
      const engine = new GameEngine(gameConfig(), 1, false);
      engine.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });
      requireCondition(
        engine.applyInput({ playerId: "a", sequence: 2, angle: 0, boosting: false }),
        "new input rejected",
      );
      requireCondition(
        !engine.applyInput({ playerId: "a", sequence: 1, angle: Math.PI, boosting: true }),
        "stale input accepted",
      );
      engine.step();
      const snake = requireSnake(engine.snapshot(), "a");
      approximately(snake.angle, 0);
      requireCondition(!snake.boosting, "stale boost intent applied");
    },
  },
  {
    name: "wire input messages are decoded through Effect Schema",
    run: () => {
      const message = Effect.runSync(
        decodeClientMessage(
          JSON.stringify({ _tag: "input", sequence: 4, angle: 1.2, boosting: true }),
        ),
      );
      requireCondition(message._tag === "input", "input tag was not decoded");
      requireCondition(message.sequence === 4 && message.boosting, "input payload was changed");
    },
  },
  {
    name: "malformed wire messages are rejected before simulation",
    run: () => {
      let rejected = false;
      try {
        Effect.runSync(decodeClientMessage('{"_tag":"input","sequence":-1}'));
      } catch {
        rejected = true;
      }
      requireCondition(rejected, "invalid input was accepted");
    },
  },
  {
    name: "short friend keys normalize, hash, and identify without plaintext storage",
    run: async () => {
      const formatted = generateAccessKey(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
      const normalized = normalizeAccessKey(formatted);
      requireCondition(normalized !== undefined, "generated key did not normalize");
      requireCondition(formatted.length === 14, "generated key is not human-sized");
      const hash = await hashAccessKey(formatted);
      requireCondition(hash !== undefined && hash.length === 64, "key hash is invalid");
      const records = new Map([[hash, "friend-a"]]);
      requireCondition((await identifyAccessKey(formatted.toLowerCase(), records)) === "friend-a", "key was not identified");
      requireCondition((await identifyAccessKey("0000-0000-0000", records)) === undefined, "unknown key was accepted");
    },
  },
  {
    name: "identical seeds produce deterministic initial worlds",
    run: () => {
      const config = gameConfig({ ambientFoodTarget: 32 });
      const left = new GameEngine(config, 7);
      const right = new GameEngine(config, 7);
      left.addSnake("a", "Alpha");
      right.addSnake("a", "Alpha");
      requireCondition(
        JSON.stringify(left.snapshot()) === JSON.stringify(right.snapshot()),
        "seeded worlds diverged",
      );
    },
  },
  {
    name: "a snake may safely coil across its own body",
    run: () => {
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
    },
  },
  {
    name: "crossing the arena wall kills the snake",
    run: () => {
      const config = gameConfig({ arenaHalfSize: 100 });
      const engine = new GameEngine(config, 1, false);
      engine.addSnake("a", "Alpha", { position: { x: 82, y: 0 }, angle: 0 });
      const events = engine.step();
      requireCondition(events.deaths.length === 1, "boundary death missing");
      requireCondition(events.deaths[0].cause._tag === "Boundary", "wrong death cause");
      requireCondition(!requireSnake(engine.snapshot(), "a").alive, "snake remained alive");
    },
  },
  {
    name: "enemy body collision awards a kill and creates contested remains",
    run: () => {
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
      requireCondition(events.deaths.some((event) => event.playerId === "victim"), "victim survived");
      requireCondition(requireSnake(snapshot, "attacker").kills === 1, "kill was not awarded");
      requireCondition(snapshot.foods.some((food) => food.kind === "remains"), "remains missing");
    },
  },
  {
    name: "death is followed by fast protected respawn",
    run: () => {
      const config = gameConfig({
        arenaHalfSize: 100,
        respawnDelayTicks: 2,
        respawnInvulnerabilityTicks: 3,
      });
      const engine = new GameEngine(config, 4, false);
      engine.addSnake("a", "Alpha", { position: { x: 82, y: 0 }, angle: 0 });
      engine.step();
      engine.step();
      const events = engine.step();
      const snake = requireSnake(engine.snapshot(), "a");
      requireCondition(events.respawnedPlayerIds.includes("a"), "respawn event missing");
      requireCondition(snake.alive, "snake did not respawn");
      requireCondition(snake.invulnerable, "respawn was not protected");
      approximately(snake.length, config.initialLength);
    },
  },
];
