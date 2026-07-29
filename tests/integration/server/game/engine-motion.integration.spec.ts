import { describe, it } from "vite-plus/test";
import { NORMAL_GAME_PI } from "$lib/game/normal-game-math";
import {
  advanceSnakeSourceFrame,
  turnTowards,
  type SnakeMotionState,
} from "$lib/game/snake-motion";
import { bodyPointIndexes, internalSkinOrDefault, skinSizeInfo } from "$lib/game/internal-skins";
import { FOOD_SIZE, foodDiameterOf } from "$lib/game/food-metrics";
import { motionRulesFor } from "$lib/server/game/config";
import { GameEngine } from "$lib/server/game/engine";
import { gameConfig } from "../../../fixtures/server/game-config";
import { requireCondition } from "../../../support/assertions";
import {
  approximately,
  requireSnake,
  sourceFrameDistance,
  tickDistance,
  tickTurn,
} from "../../../support/game-engine";

describe("authoritative game engine: motion and input", () => {
  it("base movement advances the authoritative head", () => {
    const config = gameConfig();
    const engine = new GameEngine(config, 1, false);
    engine.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });
    engine.step();
    const snake = requireSnake(engine.snapshot(), "a");
    approximately(snake.body[0].x, tickDistance(config));
    approximately(snake.body[0].y, 0);
  });
  it("turning is capped by the server turn rate", () => {
    const config = gameConfig();
    const engine = new GameEngine(config, 1, false);
    engine.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });
    engine.step([{ playerId: "a", sequence: 1, angle: Math.PI / 2, boosting: false }]);
    const snake = requireSnake(engine.snapshot(), "a");
    approximately(snake.angle, turnTowards(0, Math.PI / 2, tickTurn(config)));
  });
  it("quantizes input to integer degrees and keeps the original half-turn side", () => {
    const config = gameConfig();
    const motion = motionRulesFor(config);
    const degree = Math.PI / 180;
    const towardZero = new GameEngine(config, 1, false);
    const towardFullTurn = new GameEngine(config, 1, false);
    for (const engine of [towardZero, towardFullTurn]) {
      engine.addSnake("a", "Alpha", { position: { x: 0, y: 0 }, angle: Math.PI });
    }

    requireCondition(
      towardZero.applyInput({ playerId: "a", sequence: 1, angle: 0.49 * degree, boosting: false }),
      "zero-side input was rejected",
    );
    requireCondition(
      towardFullTurn.applyInput({
        playerId: "a",
        sequence: 1,
        angle: 359.5 * degree,
        boosting: false,
      }),
      "full-turn-side input was rejected",
    );
    approximately(requireSnake(towardZero.snapshot(), "a").targetAngle ?? -1, 0);
    approximately(
      requireSnake(towardFullTurn.snapshot(), "a").targetAngle ?? -1,
      NORMAL_GAME_PI * 2,
    );

    towardZero.step();
    towardFullTurn.step();
    const turnThisTick = motion.sourceFramesPerTick * motion.turnPerFrame;
    approximately(requireSnake(towardZero.snapshot(), "a").angle, NORMAL_GAME_PI - turnThisTick);
    approximately(
      requireSnake(towardFullTurn.snapshot(), "a").angle,
      NORMAL_GAME_PI + turnThisTick,
    );
  });
  it("uses the original integer-degree random spawn headings", () => {
    const degree = NORMAL_GAME_PI / 180;
    for (let seed = 1; seed <= 32; seed += 1) {
      const engine = new GameEngine(gameConfig(), seed, false);
      engine.addSnake("a", "Alpha", { position: { x: 0, y: 0 } });
      const angle = requireSnake(engine.snapshot(), "a").angle;
      const degrees = angle / degree;
      approximately(degrees, Math.round(degrees));
      requireCondition(degrees >= 0 && degrees < 360, "spawn heading left the 0..359 range");
    }
  });
  it("boost trades body length for tactical speed", () => {
    const config = gameConfig();
    const motion = motionRulesFor(config);
    // 加速要连续累计 boostDrainFrames + 1 个源帧才扣 1 点长度。
    const drainTicks = Math.ceil((motion.boostDrainFrames + 1) / motion.sourceFramesPerTick);
    const normal = new GameEngine(config, 1, false);
    const boosted = new GameEngine(config, 1, false);
    // 长度必须高于下限，否则按规则无法加速。
    const spawn = { position: { x: 0, y: 0 }, angle: 0, length: config.minimumLength + 120 };
    normal.addSnake("a", "Alpha", spawn);
    boosted.addSnake("a", "Alpha", spawn);
    for (let tick = 0; tick < drainTicks; tick += 1) {
      normal.step();
      boosted.step([{ playerId: "a", sequence: tick + 1, angle: 0, boosting: true }]);
    }
    const normalSnake = requireSnake(normal.snapshot(), "a");
    const boostedSnake = requireSnake(boosted.snapshot(), "a");
    approximately(
      boostedSnake.body[0].x,
      (motion.boostDrainFrames + 1) * sourceFrameDistance(config, true),
    );
    approximately(boostedSnake.length, spawn.length - 1);
    approximately(boostedSnake.score, spawn.length - 1);
    requireCondition(boostedSnake.boosting, "boost stopped above minimum length");
    requireCondition(boostedSnake.body[0].x > normalSnake.body[0].x, "boost did not add speed");
  });
  it("drops boost remains at the pre-move last rendered body node", () => {
    const config = gameConfig();
    const motion = motionRulesFor(config);
    const engine = new GameEngine(config, 1, false);
    engine.addSnake("a", "Alpha", {
      position: { x: 0, y: 0 },
      angle: 0,
      length: config.minimumLength + 120,
    });
    for (let tick = 1; tick <= 6; tick += 1) {
      engine.step([{ playerId: "a", sequence: tick, angle: 0, boosting: true }]);
    }

    const beforeDrainTick = requireSnake(engine.snapshot(), "a");
    const expectedState: SnakeMotionState = {
      body: beforeDrainTick.body.map((point) => ({ ...point })),
      angle: beforeDrainTick.angle,
      targetAngle: beforeDrainTick.targetAngle ?? beforeDrainTick.angle,
      length: beforeDrainTick.length,
      bodyScale: beforeDrainTick.bodyScale,
      boosting: true,
      boostInputHeld: true,
      boostFrames: 18,
    };
    advanceSnakeSourceFrame(expectedState, motion);
    advanceSnakeSourceFrame(expectedState, motion);
    const indexes = bodyPointIndexes(
      skinSizeInfo(internalSkinOrDefault(beforeDrainTick.skinId), expectedState.bodyScale),
      expectedState.body.length,
    );
    const expected = expectedState.body[indexes[indexes.length - 1]];
    if (expected === undefined) throw new Error("Expected boost drop node is missing");

    engine.step([{ playerId: "a", sequence: 7, angle: 0, boosting: true }]);
    const afterDrain = requireSnake(engine.snapshot(), "a");
    const remains = engine.snapshot().foods.filter((food) => food.kind === "boost-remains");
    requireCondition(remains.length === 1, "boost drain did not create exactly one remain");
    approximately(afterDrain.length, beforeDrainTick.length - 1);
    approximately(afterDrain.score, beforeDrainTick.score - 1);
    approximately(remains[0].value, 1);
    approximately(remains[0].lengthValue, 1);
    approximately(foodDiameterOf(remains[0], config), FOOD_SIZE.boostRemains);
    requireCondition(
      remains[0].variant >= 0 && remains[0].variant < 20,
      "boost remain did not use an official candy variant",
    );
    approximately(remains[0].position.x, expected.x);
    approximately(remains[0].position.y, expected.y);
  });
  it("boost is unavailable at the minimum length", () => {
    const config = gameConfig();
    const engine = new GameEngine(config, 1, false);
    engine.addSnake("a", "Alpha", {
      position: { x: 0, y: 0 },
      angle: 0,
      length: config.minimumLength,
    });
    engine.step([{ playerId: "a", sequence: 1, angle: 0, boosting: true }]);
    const snake = requireSnake(engine.snapshot(), "a");
    approximately(snake.body[0].x, tickDistance(config));
    approximately(snake.length, config.minimumLength);
  });
  it("does not auto-boost after eating while a minimum-length press stays held", () => {
    const config = gameConfig();
    const engine = new GameEngine(config, 1, false);
    engine.addSnake("a", "Alpha", {
      position: { x: 0, y: 0 },
      angle: 0,
      length: config.minimumLength,
    });
    engine.addFood({ x: 50, y: 0 }, 1);

    engine.step([{ playerId: "a", sequence: 1, angle: 0, boosting: true }]);
    const afterFood = requireSnake(engine.snapshot(), "a");
    approximately(afterFood.length, config.minimumLength + 1);
    requireCondition(!afterFood.boosting, "rejected minimum-length press became active");

    engine.step([{ playerId: "a", sequence: 2, angle: 0, boosting: true }]);
    const stillHeld = requireSnake(engine.snapshot(), "a");
    approximately(stillHeld.body[0].x - afterFood.body[0].x, tickDistance(config));
    requireCondition(!stillHeld.boosting, "held press retried without a release edge");

    engine.step([{ playerId: "a", sequence: 3, angle: 0, boosting: false }]);
    const afterRelease = requireSnake(engine.snapshot(), "a");
    engine.step([{ playerId: "a", sequence: 4, angle: 0, boosting: true }]);
    const afterFreshPress = requireSnake(engine.snapshot(), "a");
    approximately(afterFreshPress.body[0].x - afterRelease.body[0].x, tickDistance(config, true));
    requireCondition(afterFreshPress.boosting, "fresh press did not activate boost");
  });
  it("stale client input cannot overwrite newer intent", () => {
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
  });
});
