import { describe, expect, it } from "vite-plus/test";
import { NORMAL_GAME_PI } from "./normal-game-math";
import {
  advanceSnakeMotion,
  advanceSnakeSourceFrame,
  applySnakeBoostInput,
  bodyArcLength,
  bodyPointCount,
  createBody,
  nextSnakeBodyScale,
  normalizeAngle,
  normalizeSnakeDirectionDelta,
  quantizeSnakeTargetAngle,
  resizeBody,
  snakeBodyRadius,
  snakeBodyScaleFactor,
  snakeBodyWidth,
  snakeCollisionDistance,
  snakeMotionRules,
  SNAKE_BODY,
  SNAKE_MOTION,
  targetSnakeBodyScale,
  turnTowards,
  type SnakeMotionState,
} from "./snake-motion";

const MINIMUM_LENGTH = 80;
const rules = snakeMotionRules({
  tickRate: 20,
  minimumLength: MINIMUM_LENGTH,
  maximumLength: 100_000,
});

function state(overrides: Partial<SnakeMotionState> = {}): SnakeMotionState {
  const length = overrides.length ?? MINIMUM_LENGTH;
  return {
    body: overrides.body ?? createBody({ x: 0, y: 0 }, 0, length, rules),
    angle: overrides.angle ?? 0,
    targetAngle: overrides.targetAngle ?? 0,
    length,
    bodyScale: overrides.bodyScale ?? targetSnakeBodyScale(length, MINIMUM_LENGTH),
    boosting: overrides.boosting ?? false,
    boostInputHeld: overrides.boostInputHeld ?? overrides.boosting ?? false,
    boostFrames: overrides.boostFrames ?? 0,
  };
}

describe("logical length to body point count", () => {
  it("uses the segmented step table instead of a linear mapping", () => {
    // 80 / 3 = 26.67 → 26 步 → 52 点。
    expect(bodyPointCount(80, rules)).toBe(52);
    // 300 / 3 = 100 步 → 200 点。
    expect(bodyPointCount(300, rules)).toBe(200);
    // 300 之后每 4 长度一步：100 + 300/4 = 175 步 → 350 点。
    expect(bodyPointCount(600, rules)).toBe(350);
  });

  it("grows sublinearly so a long snake is not proportionally longer", () => {
    const short = bodyPointCount(300, rules);
    const long = bodyPointCount(3_000, rules);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThan(short * 10);
  });

  it("caps physical body points at the configured maximum and keeps at least two", () => {
    expect(bodyPointCount(1_000_000, rules)).toBe(bodyPointCount(rules.maximumLength, rules));
    expect(bodyPointCount(0, rules)).toBe(2);
  });

  it("derives world arc length from the fixed point spacing", () => {
    expect(bodyArcLength(80, rules)).toBeCloseTo(51 * SNAKE_MOTION.pointSpacing, 8);
  });
});

describe("discrete tick advance", () => {
  it("moves one point spacing per point and keeps the point count stable", () => {
    const snake = state();
    const pointCount = snake.body.length;
    advanceSnakeMotion(snake, rules);
    expect(snake.body.length).toBe(pointCount);
    expect(snake.body[0].x).toBeCloseTo(
      rules.sourceFramesPerTick * rules.pointsPerFrame * rules.pointSpacing,
      8,
    );
  });

  it("advances twice as many points while boosting", () => {
    const normal = state({ length: 200 });
    const boosted = state({ length: 200, boosting: true });
    advanceSnakeMotion(normal, rules);
    advanceSnakeMotion(boosted, rules);
    expect(boosted.body[0].x).toBeCloseTo(normal.body[0].x * 2, 8);
  });

  it("does not turn a rejected held press into boost after eating", () => {
    const snake = state();
    applySnakeBoostInput(snake, true, rules.minimumLength);
    expect(snake.boosting).toBe(false);
    expect(snake.boostInputHeld).toBe(true);

    snake.length += 1;
    applySnakeBoostInput(snake, true, rules.minimumLength);
    advanceSnakeSourceFrame(snake, rules);
    expect(snake.boosting).toBe(false);
    expect(snake.body[0].x).toBeCloseTo(rules.pointsPerFrame * rules.pointSpacing, 8);

    applySnakeBoostInput(snake, false, rules.minimumLength);
    applySnakeBoostInput(snake, true, rules.minimumLength);
    expect(snake.boosting).toBe(true);
  });

  it("switches to normal speed on the frame whose drain reaches minimum length", () => {
    const snake = state({
      length: MINIMUM_LENGTH + 1,
      boosting: true,
      boostInputHeld: true,
      boostFrames: rules.boostDrainFrames,
    });

    expect(advanceSnakeSourceFrame(snake, rules)).toBe(1);
    expect(snake.length).toBe(MINIMUM_LENGTH);
    expect(snake.boosting).toBe(false);
    expect(snake.body[0].x).toBeCloseTo(rules.pointsPerFrame * rules.pointSpacing, 8);

    snake.length += 1;
    advanceSnakeSourceFrame(snake, rules);
    expect(snake.boosting).toBe(false);
    expect(snake.body[0].x).toBeCloseTo(2 * rules.pointsPerFrame * rules.pointSpacing, 8);
  });

  it("caps turning per source frame, not per tick", () => {
    const snake = state({ targetAngle: Math.PI });
    advanceSnakeMotion(snake, rules);
    expect(snake.angle).toBeCloseTo(rules.sourceFramesPerTick * rules.turnPerFrame, 8);
  });

  it("quantizes player targets with the normal Game 3.14 conversion", () => {
    const inputDegree = Math.PI / 180;
    const snakeDegree = NORMAL_GAME_PI / 180;
    expect(quantizeSnakeTargetAngle(44.4 * inputDegree)).toBeCloseTo(44 * snakeDegree, 12);
    expect(quantizeSnakeTargetAngle(44.5 * inputDegree)).toBeCloseTo(45 * snakeDegree, 12);
    expect(Object.is(quantizeSnakeTargetAngle(-0.49 * inputDegree), -0)).toBe(true);
    expect(quantizeSnakeTargetAngle(-0.5 * inputDegree)).toBeCloseTo(359 * snakeDegree, 12);
    expect(quantizeSnakeTargetAngle(359.5 * inputDegree)).toBeCloseTo(NORMAL_GAME_PI * 2, 12);
  });

  it("preserves the original sign when the target is exactly 180 degrees away", () => {
    const turn = rules.turnPerFrame;
    const halfTurn = NORMAL_GAME_PI;
    expect(turnTowards(0, halfTurn, turn)).toBeCloseTo(turn, 12);
    expect(turnTowards(halfTurn, 0, turn)).toBeCloseTo(halfTurn - turn, 12);
  });

  it("preserves the original sign for equivalent signed current angles", () => {
    const turn = rules.turnPerFrame;
    const halfTurn = NORMAL_GAME_PI;
    expect(turnTowards(-halfTurn / 2, halfTurn / 2, turn)).toBeCloseTo(
      (halfTurn * 3) / 2 - turn,
      12,
    );
    expect(turnTowards(halfTurn / 2, (halfTurn * 3) / 2, turn)).toBeCloseTo(
      halfTurn / 2 + turn,
      12,
    );
  });

  it("takes the shortest path across the zero-degree boundary", () => {
    const snakeDegree = NORMAL_GAME_PI / 180;
    expect(
      normalizeSnakeDirectionDelta(turnTowards(-snakeDegree, snakeDegree, rules.turnPerFrame)),
    ).toBeCloseTo(snakeDegree, 12);
    expect(
      normalizeSnakeDirectionDelta(turnTowards(snakeDegree, -snakeDegree, rules.turnPerFrame)),
    ).toBeCloseTo(-snakeDegree, 12);
  });

  it("creates head and neck points with the newly applied source-frame direction", () => {
    for (const boosting of [false, true]) {
      const snake = state({ length: 200, targetAngle: NORMAL_GAME_PI / 2, boosting });
      advanceSnakeSourceFrame(snake, rules);
      const head = snake.body[0];
      const neck = snake.body[1];
      const neckDirection = Math.atan2(head.y - neck.y, head.x - neck.x);
      expect(Math.abs(normalizeAngle(neckDirection - snake.angle))).toBeLessThan(1e-10);
      expect(snake.angle).toBeCloseTo(rules.turnPerFrame, 12);
    }
  });

  it("uses the original 3.14 radians for direction movement", () => {
    const angle = NORMAL_GAME_PI / 2;
    const snake = state({ angle, targetAngle: angle });
    advanceSnakeSourceFrame(snake, rules);
    const distance = rules.pointsPerFrame * rules.pointSpacing;
    expect(snake.body[0].x).toBeCloseTo(distance * Math.cos(angle), 12);
    expect(snake.body[0].y).toBeCloseTo(distance * Math.sin(angle), 12);
    // 原版 90° 使用 1.57，而不是 Math.PI / 2，因此 X 分量并非严格为零。
    expect(snake.body[0].x).toBeGreaterThan(0);
  });

  it("drains exactly one length after the boost frame threshold", () => {
    const snake = state({ length: 200, boosting: true });
    let drained = 0;
    const ticksToDrain = Math.ceil((rules.boostDrainFrames + 1) / rules.sourceFramesPerTick);
    for (let tick = 0; tick < ticksToDrain - 1; tick += 1) {
      drained += advanceSnakeMotion(snake, rules);
    }
    expect(drained).toBe(0);
    drained += advanceSnakeMotion(snake, rules);
    expect(drained).toBe(1);
    expect(snake.length).toBe(199);
  });

  it("resets the boost counter when boost is released", () => {
    const snake = state({ length: 200, boosting: true });
    advanceSnakeMotion(snake, rules);
    expect(snake.boostFrames).toBeGreaterThan(0);
    snake.boosting = false;
    advanceSnakeMotion(snake, rules);
    expect(snake.boostFrames).toBe(0);
  });

  it("never drains below the minimum length", () => {
    const snake = state({ length: MINIMUM_LENGTH, boosting: true });
    for (let tick = 0; tick < 40; tick += 1) advanceSnakeMotion(snake, rules);
    expect(snake.length).toBe(MINIMUM_LENGTH);
    // 长度触底后按普通速度前进。
    expect(snake.body[0].x).toBeCloseTo(
      40 * rules.sourceFramesPerTick * rules.pointsPerFrame * rules.pointSpacing,
      6,
    );
  });
});

describe("body resizing", () => {
  it("shortens in one step and stacks new points on the tail", () => {
    const body = createBody({ x: 0, y: 0 }, 0, 80, rules);
    resizeBody(body, 4);
    expect(body.length).toBe(4);
    const tail = body[3];
    resizeBody(body, 6);
    expect(body.length).toBe(6);
    expect(body[5]).toEqual({ x: tail.x, y: tail.y });
  });

  it("limits growth per call so the body follows over several frames", () => {
    const body = createBody({ x: 0, y: 0 }, 0, 80, rules);
    const pointCount = body.length;
    resizeBody(body, pointCount + 10, 2);
    expect(body.length).toBe(pointCount + 2);
  });
});

describe("body scale", () => {
  it("uses the normal Game/Snake floating-point scale target", () => {
    expect(snakeBodyScaleFactor(MINIMUM_LENGTH)).toBeCloseTo(0.000_018_014_411_529_223_38, 18);
    expect(targetSnakeBodyScale(MINIMUM_LENGTH, MINIMUM_LENGTH)).toBe(1);
    expect(targetSnakeBodyScale(5_631, MINIMUM_LENGTH)).toBeCloseTo(1.099_997_998_398_719, 15);
    expect(targetSnakeBodyScale(5_632, MINIMUM_LENGTH)).toBeCloseTo(1.100_016_012_810_248_3, 15);
    expect(targetSnakeBodyScale(1_000_000, MINIMUM_LENGTH)).toBe(2.8);
  });

  it("keeps the current scale until the floating target differs by strictly more than 0.1", () => {
    const firstScale = targetSnakeBodyScale(5_632, MINIMUM_LENGTH);
    expect(nextSnakeBodyScale(1, 5_631, MINIMUM_LENGTH)).toBe(1);
    expect(nextSnakeBodyScale(1, 5_632, MINIMUM_LENGTH)).toBe(firstScale);
    expect(nextSnakeBodyScale(firstScale, 11_183, MINIMUM_LENGTH)).toBe(firstScale);
    expect(nextSnakeBodyScale(firstScale, 11_184, MINIMUM_LENGTH)).toBe(
      targetSnakeBodyScale(11_184, MINIMUM_LENGTH),
    );
    expect(snakeBodyWidth(firstScale)).toBeCloseTo(39.600_576_461_168_94, 12);
  });

  it("updates the scale after moving each source frame", () => {
    const belowThreshold = state({ length: 5_631, bodyScale: 1 });
    advanceSnakeMotion(belowThreshold, rules);
    expect(belowThreshold.bodyScale).toBe(1);

    const crossingThreshold = state({ length: 5_632, bodyScale: 1 });
    advanceSnakeMotion(crossingThreshold, rules);
    expect(crossingThreshold.bodyScale).toBeCloseTo(1.100_016_012_810_248_3, 15);
  });

  it("advances one original source frame independently of the authority tick", () => {
    const frame = state();
    advanceSnakeSourceFrame(frame, rules);
    expect(frame.body[0].x).toBeCloseTo(4.5, 8);
    expect(frame.body[0].y).toBe(0);
  });

  it("uses one 36-unit body width for rendering and old-endless collisions", () => {
    expect(snakeBodyWidth(1)).toBe(SNAKE_BODY.width);
    expect(snakeBodyRadius(1)).toBe(18);
    expect(snakeBodyWidth(1.201)).toBeCloseTo(43.236, 8);
    expect(snakeCollisionDistance(1, 1)).toBe(18);
    expect(snakeCollisionDistance(1, 2)).toBe(27);
  });
});
