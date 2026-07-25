import { describe, expect, it } from "vite-plus/test";
import type { ClientGameRules, SnakeSnapshot } from "$lib/protocol";
import { advanceSnakeMotion, normalizeAngle, type SnakeMotionState } from "../../game/snake-motion";
import { SelfPredictor } from "./self-predictor";

const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;

const rules: ClientGameRules = {
  arenaHalfSize: 1000,
  baseSpeed: 100,
  boostSpeed: 200,
  turnRate: 4,
  initialLength: 100,
  minimumLength: 50,
  boostMinimumLength: 60,
  boostDrainPerSecond: 10,
  foodRadius: 5,
  respawnDelayTicks: 30,
  respawnInvulnerabilityTicks: 40,
};

function initialMotion(): SnakeMotionState {
  return {
    body: [
      { x: 0, y: 0 },
      { x: -100, y: 0 },
    ],
    angle: 0,
    targetAngle: 0,
    length: 100,
    boosting: false,
  };
}

function stepMotion(state: SnakeMotionState, targetAngle: number, boosting: boolean): void {
  state.targetAngle = targetAngle;
  state.boosting = boosting;
  advanceSnakeMotion(state, rules, TICK_MS / 1000);
}

function snapshotOf(state: SnakeMotionState): SnakeSnapshot {
  return {
    id: "self",
    nickname: "Self",
    body: state.body.map((point) => ({ ...point })),
    angle: state.angle,
    targetAngle: state.targetAngle,
    radius: 10,
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
  it("tracks local steering immediately before the next server tick", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);

    predictor.advance(20, Math.PI / 2, false);
    const rendered = predictor.renderState();
    expect(rendered).toBeDefined();
    expect(head(rendered!).x).toBeGreaterThan(0);
    expect(rendered!.angle).toBe(Math.PI / 2);
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
    for (let now = 5; now <= 200; now += 5) {
      predictor.advance(now, Math.PI / 2, true);
      const current = predictor.renderState();
      expect(current).toBeDefined();
      const distance = Math.hypot(
        head(current!).x - head(previous!).x,
        head(current!).y - head(previous!).y,
      );
      expect(distance).toBeGreaterThan(0.9);
      expect(distance).toBeLessThan(1.1);
      previous = current;
    }
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
    predictor.advance(25, Math.PI / 2, false);
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

    predictor.advance(49, Math.PI / 2, false);
    const before = head(predictor.renderState()!);
    predictor.advance(50, Math.PI / 2, false);
    const boundary = head(predictor.renderState()!);
    expect(boundary.x).toBeCloseTo(expectedBoundary!.x, 8);
    expect(boundary.y).toBeCloseTo(expectedBoundary!.y, 8);
    predictor.advance(51, Math.PI / 2, false);
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
      predictor.advance(now, Math.PI / 2, false);
      const rendered = head(predictor.renderState()!);
      expect(distanceToSegment(rendered, start!, end!)).toBeLessThan(segmentLength * 0.04);
    }
  });

  it("does not change the visible pose for normal network drift", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0);
    predictor.advance(120, Math.PI / 2, true);
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
      withSnapshots.advance(now, Math.PI / 2, false);
      withoutSnapshots.advance(now, Math.PI / 2, false);
      if (now % 100 === 0) {
        withSnapshots.reconcile(snapshotOf(server), now / TICK_MS, now);
      }
      expectSamePose(withoutSnapshots.renderState()!, withSnapshots.renderState()!);
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
      predictor.advance(100, undefined, false);
    }
    stepMotion(server, 0, false);
    stepMotion(server, 0, false);
    withSnapshot.reconcile(snapshotOf(server), 2, 100);

    withSnapshot.advance(150, undefined, false);
    baseline.advance(150, undefined, false);
    expectSamePose(baseline.renderState()!, withSnapshot.renderState()!);
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
    predictor.advance(100, Math.PI / 2, false);
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

    predictor.advance(55, undefined, false);
    const rendered = predictor.renderState();
    expect(rendered).toBeDefined();
    expect(rendered!.angle).toBeGreaterThan(0);
  });

  it("rebases after a genuinely large positional drift", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);
    const farAway = initialMotion();
    farAway.body = [
      { x: 200, y: 0 },
      { x: 100, y: 0 },
    ];
    predictor.reconcile(snapshotOf(farAway), 1, 50);
    expect(head(predictor.renderState()!).x).toBe(210);
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
    predictor.advance(50, Math.PI / 2, false);

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
    predictor.advance(100, Math.PI / 2, false);

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
    predictor.advance(100, Math.PI / 2, true);

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
