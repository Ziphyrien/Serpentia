import { describe, expect, it } from "vite-plus/test";
import type { ClientGameRules, SnakeSnapshot } from "$lib/protocol";
import { advanceSnakeMotion, type SnakeMotionState } from "../../game/snake-motion";
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

describe("self prediction reconciliation", () => {
  it("keeps a low-latency straight-line snapshot visually continuous", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0, 20, 0, false);

    predictor.advance(55, 0, false);
    predictor.advance(105, 0, false);
    const before = predictor.renderState(120);
    expect(before).toBeDefined();

    stepMotion(server, 0, false);
    stepMotion(server, 0, false);
    predictor.reconcile(snapshotOf(server), 2, 100, 120, 0, false);
    const after = predictor.renderState(120);
    expect(after).toBeDefined();
    expectSamePose(before!, after!);
  });

  it("keeps repeated turn and boost corrections continuous", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0, 20, Math.PI / 2, true);

    // Local prediction responds immediately, while the server receives the input one tick later.
    predictor.advance(55, Math.PI / 2, true);
    predictor.advance(105, Math.PI / 2, true);
    stepMotion(server, 0, false);
    stepMotion(server, Math.PI / 2, true);

    const beforeFirst = predictor.renderState(120);
    expect(beforeFirst).toBeDefined();
    predictor.reconcile(snapshotOf(server), 2, 100, 120, Math.PI / 2, true);
    const afterFirst = predictor.renderState(120);
    expect(afterFirst).toBeDefined();
    expectSamePose(beforeFirst!, afterFirst!);

    predictor.advance(155, Math.PI / 2, true);
    predictor.advance(205, Math.PI / 2, true);
    stepMotion(server, Math.PI / 2, true);
    stepMotion(server, Math.PI / 2, true);

    const beforeSecond = predictor.renderState(220);
    expect(beforeSecond).toBeDefined();
    predictor.reconcile(snapshotOf(server), 4, 200, 220, Math.PI / 2, true);
    const afterSecond = predictor.renderState(220);
    expect(afterSecond).toBeDefined();
    expectSamePose(beforeSecond!, afterSecond!);
  });

  it("continues the authoritative steering target without a local direction", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    server.targetAngle = Math.PI / 2;
    predictor.reconcile(snapshotOf(server), 0, 0, 20, undefined, false);

    predictor.advance(55, undefined, false);
    const rendered = predictor.renderState(100);
    expect(rendered).toBeDefined();
    expect(rendered!.angle).toBeGreaterThan(0);
  });
});
