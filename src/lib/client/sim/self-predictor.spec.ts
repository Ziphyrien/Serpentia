import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SKIN_ID } from "$lib/game/internal-skins";
import type { ClientGameRules, SnakeSnapshot } from "$lib/protocol";
import {
  advanceSnakeMotion,
  advanceSnakeSourceFrame,
  applySnakeBoostInput,
  createBody,
  normalizeAngle,
  snakeMotionRules,
  targetSnakeBodyScale,
  type SnakeMotionState,
} from "../../game/snake-motion";
import { SelfPredictor } from "./self-predictor";

const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;

const rules: ClientGameRules = {
  arenaHalfSize: 1000,
  initialLength: 80,
  minimumLength: 80,
  maximumLength: 100_000,
  eatDistanceFactor: 1.6,
  starFoodValue: 10,
  respawnDelayTicks: 30,
  respawnInvulnerabilityTicks: 40,
};

const motion = snakeMotionRules({
  tickRate: TICK_RATE,
  minimumLength: rules.minimumLength,
  maximumLength: rules.maximumLength,
});

function initialMotion(): SnakeMotionState {
  // 长度高于下限，加速相关断言才有意义。
  const length = rules.minimumLength + 120;
  return {
    body: createBody({ x: 0, y: 0 }, 0, length, motion),
    angle: 0,
    targetAngle: 0,
    length,
    bodyScale: targetSnakeBodyScale(length, rules.minimumLength),
    boosting: false,
    boostInputHeld: false,
    boostFrames: 0,
  };
}

/** 一个 tick 前进的世界距离。 */
function tickDistance(boosting = false): number {
  const points = boosting ? motion.boostPointsPerFrame : motion.pointsPerFrame;
  return motion.sourceFramesPerTick * points * motion.pointSpacing;
}

function stepMotion(state: SnakeMotionState, targetAngle: number, boosting: boolean): void {
  state.targetAngle = targetAngle;
  applySnakeBoostInput(state, boosting, motion.minimumLength);
  advanceSnakeMotion(state, motion);
}

function snapshotOf(state: SnakeMotionState): SnakeSnapshot {
  return {
    id: "self",
    nickname: "Self",
    skinId: DEFAULT_SKIN_ID,
    body: state.body.map((point) => ({ ...point })),
    angle: state.angle,
    targetAngle: state.targetAngle,
    bodyScale: state.bodyScale,
    length: state.length,
    score: 0,
    kills: 0,
    boosting: state.boosting,
    alive: true,
    invulnerable: false,
    respawnAtTick: null,
    lastInputSequence: -1,
    lastInputAppliedTick: 0,
  };
}

function head(state: { readonly body: ReadonlyArray<{ x: number; y: number }> }): {
  x: number;
  y: number;
} {
  const point = state.body[0];
  if (!point) throw new Error("rendered snake has no head");
  return point;
}

function expectSamePose(
  left: { readonly body: ReadonlyArray<{ x: number; y: number }>; readonly angle: number },
  right: { readonly body: ReadonlyArray<{ x: number; y: number }>; readonly angle: number },
): void {
  expect(head(right).x).toBeCloseTo(head(left).x, 8);
  expect(head(right).y).toBeCloseTo(head(left).y, 8);
  expect(right.angle).toBeCloseTo(left.angle, 8);
}

function expectSameBody(
  left: { readonly body: ReadonlyArray<{ x: number; y: number }> },
  right: { readonly body: ReadonlyArray<{ x: number; y: number }> },
): void {
  expect(right.body).toHaveLength(left.body.length);
  for (let index = 0; index < left.body.length; index += 1) {
    const leftPoint = left.body[index];
    const rightPoint = right.body[index];
    expect(leftPoint).toBeDefined();
    expect(rightPoint).toBeDefined();
    if (leftPoint === undefined || rightPoint === undefined) continue;
    expect(rightPoint.x).toBeCloseTo(leftPoint.x, 8);
    expect(rightPoint.y).toBeCloseTo(leftPoint.y, 8);
  }
}

function distanceToSegment(
  point: { readonly x: number; readonly y: number },
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const ratio = Math.min(1, Math.max(0, projection));
  return Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio));
}

describe("self prediction", () => {
  it("responds to local steering without snapping to the target", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);
    predictor.scheduleInput({
      sequence: 1,
      targetTick: predictor.nextInputTick,
      angle: Math.PI / 2,
      boosting: false,
    });

    predictor.advance(20);
    const rendered = predictor.renderState();
    expect(rendered).toBeDefined();
    expect(head(rendered!).x).toBeGreaterThan(0);
    expect(rendered!.angle).toBeGreaterThan(0);
    expect(rendered!.angle).toBeLessThan(Math.PI / 2);
  });

  it("keeps the rendered heading on the path the body actually takes", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);
    predictor.scheduleInput({
      sequence: 1,
      targetTick: predictor.nextInputTick,
      angle: Math.PI,
      boosting: false,
    });

    // A U-turn is where a decoupled visual angle used to run far ahead of the body.
    for (let now = 10; now <= 400; now += 10) {
      predictor.advance(now);
      const rendered = predictor.renderState();
      expect(rendered).toBeDefined();
      const body = rendered!.body;
      const neck = body[1];
      if (neck === undefined) continue;
      const travelled = Math.hypot(head(rendered!).x - neck.x, head(rendered!).y - neck.y);
      if (travelled < 1e-6) continue;
      const bodyHeading = Math.atan2(head(rendered!).y - neck.y, head(rendered!).x - neck.x);
      expect(Math.abs(normalizeAngle(rendered!.angle - bodyHeading))).toBeLessThan(
        motion.turnPerFrame + 0.001,
      );
    }
  });

  it("keeps local movement and boost smooth across fixed ticks", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);
    predictor.scheduleInput({
      sequence: 1,
      targetTick: predictor.nextInputTick,
      angle: Math.PI / 2,
      boosting: true,
    });

    let previous = predictor.renderState();
    expect(previous).toBeDefined();
    const step = tickDistance(true) * (5 / TICK_MS);
    for (let now = 5; now <= 200; now += 5) {
      predictor.advance(now);
      const current = predictor.renderState();
      expect(current).toBeDefined();
      const distance = Math.hypot(
        head(current!).x - head(previous!).x,
        head(current!).y - head(previous!).y,
      );
      expect(distance).toBeGreaterThan(step * 0.85);
      expect(distance).toBeLessThan(step * 1.15);
      expect(current!.angle).toBeGreaterThanOrEqual(previous!.angle);
      expect(current!.angle - previous!.angle).toBeLessThanOrEqual(
        motion.sourceFramesPerTick * motion.turnPerFrame * (5 / TICK_MS) + 0.001,
      );
      previous = current;
    }
  });

  it("does not auto-boost when authoritative food arrives during a rejected held press", () => {
    const server = initialMotion();
    server.length = rules.minimumLength;
    server.bodyScale = targetSnakeBodyScale(server.length, rules.minimumLength);
    server.body = createBody({ x: 0, y: 0 }, 0, server.length, motion);
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(server), 0, 0);

    const rejectedTick = predictor.nextInputTick;
    predictor.scheduleInput({ sequence: 1, targetTick: rejectedTick, angle: 0, boosting: true });
    predictor.advance(50);

    advanceSnakeMotion(server, motion);
    advanceSnakeMotion(server, motion);
    applySnakeBoostInput(server, true, motion.minimumLength);
    advanceSnakeMotion(server, motion);
    server.length += 1;
    predictor.reconcile(
      {
        ...snapshotOf(server),
        lastInputSequence: 1,
        lastInputAppliedTick: rejectedTick,
      },
      rejectedTick,
      50,
    );

    const afterFood = head(predictor.renderState()!);
    predictor.advance(100);
    const stillHeld = predictor.renderState();
    expect(stillHeld?.boosting).toBe(false);
    expect(head(stillHeld!).x - afterFood.x).toBeCloseTo(tickDistance(), 8);

    predictor.scheduleInput({
      sequence: 2,
      targetTick: predictor.nextInputTick,
      angle: 0,
      boosting: true,
    });
    predictor.advance(150);
    expect(predictor.renderState()?.boosting).toBe(false);

    predictor.scheduleInput({
      sequence: 3,
      targetTick: predictor.nextInputTick,
      angle: 0,
      boosting: false,
    });
    predictor.advance(200);
    const beforeFreshPress = head(predictor.renderState()!);
    predictor.scheduleInput({
      sequence: 4,
      targetTick: predictor.nextInputTick,
      angle: 0,
      boosting: true,
    });
    predictor.advance(250);
    const freshPress = predictor.renderState();
    expect(freshPress?.boosting).toBe(true);
    expect(
      Math.hypot(
        head(freshPress!).x - beforeFreshPress.x,
        head(freshPress!).y - beforeFreshPress.y,
      ),
    ).toBeCloseTo(tickDistance(true), 8);
  });

  it("replays a future boost press after food raises length above minimum", () => {
    const server = initialMotion();
    server.length = rules.minimumLength;
    server.bodyScale = targetSnakeBodyScale(server.length, rules.minimumLength);
    server.body = createBody({ x: 0, y: 0 }, 0, server.length, motion);
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(server), 0, 0);

    const boostTick = predictor.nextInputTick;
    predictor.scheduleInput({ sequence: 1, targetTick: boostTick, angle: 0, boosting: true });
    predictor.advance(TICK_MS);
    expect(predictor.renderState()?.boosting).toBe(false);

    advanceSnakeMotion(server, motion);
    advanceSnakeMotion(server, motion);
    server.length += 1;
    const beforeFoodSnapshot = predictor.renderState();
    expect(beforeFoodSnapshot).toBeDefined();
    predictor.reconcile(snapshotOf(server), 2, TICK_MS);
    const afterFoodSnapshot = predictor.renderState();
    expect(afterFoodSnapshot).toBeDefined();
    if (beforeFoodSnapshot === undefined || afterFoodSnapshot === undefined) {
      throw new Error("predicted snake disappeared before its future boost press");
    }
    expectSamePose(beforeFoodSnapshot, afterFoodSnapshot);
    expect(afterFoodSnapshot.boosting).toBe(true);
  });

  it("replays predicted future without snapping when food prevents boost exhaustion", () => {
    const server = initialMotion();
    server.length = rules.minimumLength + 1;
    server.bodyScale = targetSnakeBodyScale(server.length, rules.minimumLength);
    server.body = createBody({ x: 0, y: 0 }, 0, server.length, motion);
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(server), 0, 0);

    const boostTick = predictor.nextInputTick;
    predictor.scheduleInput({ sequence: 1, targetTick: boostTick, angle: 0, boosting: true });
    for (let now = TICK_MS; now <= 8 * TICK_MS; now += TICK_MS) predictor.advance(now);
    expect(predictor.renderState()?.boosting).toBe(false);

    for (let tick = 1; tick <= 8; tick += 1) {
      if (tick === boostTick) applySnakeBoostInput(server, true, motion.minimumLength);
      advanceSnakeMotion(server, motion);
    }
    expect(server.boosting).toBe(true);
    expect(server.boostFrames).toBe(18);
    server.length += 1;

    const beforeFoodSnapshot = predictor.renderState();
    expect(beforeFoodSnapshot).toBeDefined();
    predictor.reconcile(
      {
        ...snapshotOf(server),
        lastInputSequence: 1,
        lastInputAppliedTick: boostTick,
      },
      8,
      8 * TICK_MS,
    );
    const afterFoodSnapshot = predictor.renderState();
    expect(afterFoodSnapshot).toBeDefined();
    if (beforeFoodSnapshot === undefined || afterFoodSnapshot === undefined) {
      throw new Error("predicted snake disappeared around food reconciliation");
    }
    expectSamePose(beforeFoodSnapshot, afterFoodSnapshot);
    expect(afterFoodSnapshot.boosting).toBe(true);
  });

  it("smooths an authoritative food correction after boost already diverged", () => {
    const server = initialMotion();
    server.length = rules.minimumLength + 1;
    server.bodyScale = targetSnakeBodyScale(server.length, rules.minimumLength);
    server.body = createBody({ x: 0, y: 0 }, 0, server.length, motion);
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(server), 0, 0);

    const boostTick = predictor.nextInputTick;
    predictor.scheduleInput({ sequence: 1, targetTick: boostTick, angle: 0, boosting: true });
    for (let now = TICK_MS; now <= 9 * TICK_MS; now += TICK_MS) predictor.advance(now);
    expect(predictor.renderState()?.boosting).toBe(false);

    for (let tick = 1; tick <= 8; tick += 1) {
      if (tick === boostTick) applySnakeBoostInput(server, true, motion.minimumLength);
      advanceSnakeMotion(server, motion);
    }
    advanceSnakeSourceFrame(server, motion);
    server.length += 1;
    advanceSnakeSourceFrame(server, motion);
    advanceSnakeSourceFrame(server, motion);
    expect(server.boosting).toBe(true);
    expect(server.length).toBe(rules.minimumLength + 1);

    const beforeCorrection = predictor.renderState();
    expect(beforeCorrection).toBeDefined();
    const authoritativeSnapshot = {
      ...snapshotOf(server),
      lastInputSequence: 1,
      lastInputAppliedTick: boostTick,
    };
    const baseline = new SelfPredictor(rules, TICK_RATE);
    baseline.reconcile(authoritativeSnapshot, 9, 9 * TICK_MS);
    predictor.reconcile(authoritativeSnapshot, 9, 9 * TICK_MS);
    const afterCorrection = predictor.renderState();
    expect(afterCorrection).toBeDefined();
    if (beforeCorrection === undefined || afterCorrection === undefined) {
      throw new Error("predicted snake disappeared during boost correction");
    }
    expectSamePose(beforeCorrection, afterCorrection);
    expect(afterCorrection.boosting).toBe(true);

    let previous = afterCorrection;
    for (let now = 9 * TICK_MS + 10; now <= 9 * TICK_MS + 180; now += 10) {
      predictor.advance(now);
      baseline.advance(now);
      const current = predictor.renderState();
      expect(current).toBeDefined();
      if (current === undefined) throw new Error("predicted snake disappeared while smoothing");
      expect(
        Math.hypot(head(current).x - head(previous).x, head(current).y - head(previous).y),
      ).toBeLessThan(8);
      previous = current;
    }
    const baselineAfterSmoothing = baseline.renderState();
    expect(baselineAfterSmoothing).toBeDefined();
    if (baselineAfterSmoothing === undefined) throw new Error("baseline snake disappeared");
    expectSamePose(baselineAfterSmoothing, previous);
  });

  it("samples boost collision at one source frame instead of the whole tick endpoint", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);
    const before = predictor.renderState();
    expect(before).toBeDefined();
    const targetTick = predictor.nextInputTick;
    predictor.scheduleInput({
      sequence: 1,
      targetTick,
      angle: 0,
      boosting: true,
    });
    const tickEndpoint = predictor.headAtTick(targetTick);
    expect(tickEndpoint).toBeDefined();

    predictor.advance(1);
    const collision = predictor.renderState();
    expect(collision).toBeDefined();
    expect(collision!.collisionSourceFrame).toBe(Math.ceil(collision!.presentationSourceFrame));
    expect(collision!.collisionHead.x - before!.collisionHead.x).toBeCloseTo(
      motion.boostPointsPerFrame * motion.pointSpacing,
      8,
    );
    expect(collision!.collisionHead.x).toBeLessThan(tickEndpoint!.x);
    expect(collision!.collisionHead.y).toBeCloseTo(0, 8);
  });

  it("does not rewrite an interpolation segment after it becomes visible", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);
    const firstTargetTick = predictor.nextInputTick;
    predictor.scheduleInput({
      sequence: 1,
      targetTick: firstTargetTick,
      angle: Math.PI / 2,
      boosting: false,
    });
    predictor.advance(25);
    const before = predictor.renderState();
    expect(before).toBeDefined();

    const laterTargetTick = predictor.nextInputTick;
    expect(laterTargetTick).toBe(firstTargetTick + 1);
    predictor.scheduleInput({
      sequence: 2,
      targetTick: laterTargetTick,
      angle: -Math.PI / 2,
      boosting: false,
    });
    const after = predictor.renderState();
    expect(after).toBeDefined();
    expectSamePose(before!, after!);
  });

  it("applies a larger measured lead without moving the visible pose", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);
    predictor.advance(25);
    const before = predictor.renderState();
    const previousTargetTick = predictor.nextInputTick;

    predictor.setPredictionLeadTicks(3);

    expect(predictor.nextInputTick).toBe(previousTargetTick + 1);
    expectSamePose(before!, predictor.renderState()!);
  });

  it("keeps head velocity direction continuous across a turn tick", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);
    const targetTick = predictor.nextInputTick;
    predictor.scheduleInput({
      sequence: 1,
      targetTick,
      angle: Math.PI / 2,
      boosting: false,
    });
    const expectedBoundary = predictor.headAtTick(targetTick);
    expect(expectedBoundary).toBeDefined();

    predictor.advance(49);
    const before = head(predictor.renderState()!);
    predictor.advance(50);
    const boundary = head(predictor.renderState()!);
    expect(boundary.x).toBeCloseTo(expectedBoundary!.x, 8);
    expect(boundary.y).toBeCloseTo(expectedBoundary!.y, 8);
    predictor.advance(51);
    const after = head(predictor.renderState()!);
    const incomingAngle = Math.atan2(boundary.y - before.y, boundary.x - before.x);
    const outgoingAngle = Math.atan2(after.y - boundary.y, after.x - boundary.x);

    expect(Math.abs(normalizeAngle(outgoingAngle - incomingAngle))).toBeLessThan(0.02);
  });

  it("keeps the smooth turn close to its deterministic authority segment", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);
    const targetTick = predictor.nextInputTick;
    predictor.scheduleInput({
      sequence: 1,
      targetTick,
      angle: Math.PI / 2,
      boosting: false,
    });
    const start = predictor.headAtTick(targetTick - 1);
    const end = predictor.headAtTick(targetTick);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    const segmentLength = Math.hypot(end!.x - start!.x, end!.y - start!.y);

    for (let now = 5; now < TICK_MS; now += 5) {
      predictor.advance(now);
      const rendered = head(predictor.renderState()!);
      expect(distanceToSegment(rendered, start!, end!)).toBeLessThan(segmentLength * 0.06);
    }
  });

  it("does not change the visible pose for normal network drift", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0);
    predictor.advance(120);
    const before = predictor.renderState();
    expect(before).toBeDefined();

    stepMotion(server, 0, false);
    predictor.reconcile(snapshotOf(server), 1, 120);
    const after = predictor.renderState();
    expect(after).toBeDefined();
    expectSamePose(before!, after!);
  });

  it("keeps every frame identical to a snapshot-free turn", () => {
    const withSnapshots = new SelfPredictor(rules, TICK_RATE);
    const withoutSnapshots = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    const initial = snapshotOf(server);
    withSnapshots.reconcile(initial, 0, 0);
    withoutSnapshots.reconcile(initial, 0, 0);
    withSnapshots.scheduleInput({
      sequence: 1,
      targetTick: withSnapshots.nextInputTick,
      angle: Math.PI / 2,
      boosting: false,
    });
    withoutSnapshots.scheduleInput({
      sequence: 1,
      targetTick: withoutSnapshots.nextInputTick,
      angle: Math.PI / 2,
      boosting: false,
    });

    for (let now = 5; now <= 800; now += 5) {
      if (now % TICK_MS === 0) {
        stepMotion(server, now <= 100 ? 0 : Math.PI / 2, false);
      }
      withSnapshots.advance(now);
      withoutSnapshots.advance(now);
      if (now % 100 === 0) {
        withSnapshots.reconcile(snapshotOf(server), now / TICK_MS, now);
      }
      const reference = withoutSnapshots.renderState()!;
      const reconciled = withSnapshots.renderState()!;
      expectSamePose(reference, reconciled);
      expectSameBody(reference, reconciled);
    }
  });

  it("does not overwrite a replayed future target after direction is released", () => {
    const withSnapshot = new SelfPredictor(rules, TICK_RATE);
    const baseline = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    withSnapshot.reconcile(snapshotOf(server), 0, 0);
    baseline.reconcile(snapshotOf(server), 0, 0);
    for (const predictor of [withSnapshot, baseline]) {
      predictor.scheduleInput({
        sequence: 1,
        targetTick: 3,
        angle: Math.PI / 2,
        boosting: false,
      });
      predictor.advance(100);
    }
    stepMotion(server, 0, false);
    stepMotion(server, 0, false);
    withSnapshot.reconcile(snapshotOf(server), 2, 100);

    withSnapshot.advance(150);
    baseline.advance(150);
    const baselineState = baseline.renderState()!;
    const replayedState = withSnapshot.renderState()!;
    expectSamePose(baselineState, replayedState);
    expectSameBody(baselineState, replayedState);
  });

  it("applies authoritative length without moving the head", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0);
    predictor.scheduleInput({
      sequence: 1,
      targetTick: predictor.nextInputTick,
      angle: Math.PI / 2,
      boosting: false,
    });
    predictor.advance(100);
    const before = predictor.renderState();
    stepMotion(server, 0, false);
    stepMotion(server, 0, false);
    server.length = 80;

    predictor.reconcile(snapshotOf(server), 2, 100);
    const after = predictor.renderState();
    expectSamePose(before!, after!);
    expect(predictor.currentLength).toBe(80);
  });

  it("continues the authoritative target before local direction input exists", () => {
    const server = initialMotion();
    server.targetAngle = Math.PI / 2;
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(server), 0, 0);

    predictor.advance(55);
    const rendered = predictor.renderState();
    expect(rendered).toBeDefined();
    expect(rendered!.angle).toBeGreaterThan(0);
  });

  it("rebases after a genuinely large positional drift", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);
    const farAway = initialMotion();
    farAway.body = createBody({ x: 200, y: 0 }, 0, farAway.length, motion);
    predictor.reconcile(snapshotOf(farAway), 1, 50);
    // 重基线后立即补上预测提前量，两个 tick 的推进距离可由规则算出。
    expect(head(predictor.renderState()!).x).toBeCloseTo(200 + 2 * tickDistance(), 6);
  });

  it("keeps an applied ack input available until its target tick is simulated", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0);
    const targetTick = predictor.nextInputTick;
    predictor.scheduleInput({
      sequence: 1,
      targetTick,
      angle: Math.PI / 2,
      boosting: false,
    });
    predictor.acknowledgeInput(1, targetTick, targetTick);
    predictor.advance(50);

    stepMotion(server, 0, false);
    stepMotion(server, 0, false);
    stepMotion(server, Math.PI / 2, false);
    expect(head(predictor.renderState()!).x).toBeCloseTo(head(server).x, 8);
    expect(head(predictor.renderState()!).y).toBeCloseTo(head(server).y, 8);
  });

  it("remaps a late input and replays to the same authoritative head pose", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0);
    predictor.scheduleInput({
      sequence: 1,
      targetTick: 3,
      angle: Math.PI / 2,
      boosting: false,
    });
    predictor.advance(100);

    stepMotion(server, 0, false);
    stepMotion(server, 0, false);
    stepMotion(server, 0, false);
    stepMotion(server, Math.PI / 2, false);
    predictor.acknowledgeInput(1, 3, 4);
    const replayed = predictor.renderState()!;
    expect(head(replayed).x).toBeCloseTo(head(server).x, 8);
    expect(head(replayed).y).toBeCloseTo(head(server).y, 8);

    const authoritative = {
      ...snapshotOf(server),
      lastInputSequence: 1,
      lastInputAppliedTick: 4,
    };
    predictor.reconcile(authoritative, 4, 100);
    const afterSnapshot = predictor.renderState()!;
    expect(head(afterSnapshot).x).toBeCloseTo(head(replayed).x, 8);
    expect(head(afterSnapshot).y).toBeCloseTo(head(replayed).y, 8);
  });

  it("overwrites one target tick without increasing the prediction lead", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);
    const targetTick = predictor.nextInputTick;
    predictor.scheduleInput({ sequence: 1, targetTick, angle: 0, boosting: false });
    expect(predictor.nextInputTick).toBe(targetTick);
    predictor.scheduleInput({
      sequence: 2,
      targetTick: predictor.nextInputTick,
      angle: Math.PI / 2,
      boosting: true,
    });
    expect(predictor.nextInputTick).toBe(targetTick);
  });

  it("initializes a respawn from its new authoritative pose", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const original = initialMotion();
    predictor.reconcile(snapshotOf(original), 0, 0);
    predictor.advance(100);

    predictor.reconcile({ ...snapshotOf(original), alive: false }, 2, 100);
    expect(predictor.renderState()).toBeUndefined();

    const respawned = initialMotion();
    respawned.body = [
      { x: 400, y: 300 },
      { x: 300, y: 300 },
    ];
    predictor.reconcile(snapshotOf(respawned), 3, 150);
    const respawnedFuture = { ...respawned, body: respawned.body.map((point) => ({ ...point })) };
    stepMotion(respawnedFuture, respawnedFuture.targetAngle, false);
    stepMotion(respawnedFuture, respawnedFuture.targetAngle, false);
    expectSamePose(respawnedFuture, predictor.renderState()!);
  });
});
