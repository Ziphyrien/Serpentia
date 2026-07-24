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

function expectSameHead(
  left: { readonly body: ReadonlyArray<{ x: number; y: number }> },
  right: { readonly body: ReadonlyArray<{ x: number; y: number }> },
): void {
  expect(head(right).x).toBeCloseTo(head(left).x, 8);
  expect(head(right).y).toBeCloseTo(head(left).y, 8);
}

function expectSamePose(
  left: { readonly body: ReadonlyArray<{ x: number; y: number }>; readonly angle: number },
  right: { readonly body: ReadonlyArray<{ x: number; y: number }>; readonly angle: number },
): void {
  expectSameHead(left, right);
  expect(right.angle).toBeCloseTo(left.angle, 8);
}

describe("self prediction", () => {
  it("renders movement and steering before the next server tick", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);

    predictor.advance(20, Math.PI / 2, false);
    const rendered = predictor.renderState();
    expect(rendered).toBeDefined();
    expect(head(rendered!).x).toBeGreaterThan(0);
    expect(rendered!.angle).toBeGreaterThan(0);
  });

  it("keeps local turning and boost smooth across fixed ticks", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(snapshotOf(initialMotion()), 0, 0);

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
      expect(current!.angle).toBeGreaterThan(previous!.angle);
      expect(current!.angle - previous!.angle).toBeLessThanOrEqual(0.021);
      previous = current;
    }
  });

  it("does not pull the local pose back for normal network-sized drift", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0);
    predictor.advance(120, Math.PI / 2, true);
    const before = predictor.renderState();
    expect(before).toBeDefined();

    // The server is one or two ticks behind the local intent, but not truly lost.
    stepMotion(server, 0, false);
    predictor.reconcile(snapshotOf(server), 1, 120);
    const after = predictor.renderState();
    expect(after).toBeDefined();
    expectSamePose(before!, after!);
  });

  it("keeps repeated turning snapshots from changing the local pose", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0);

    for (let now = 10; now <= 600; now += 10) {
      if (now % TICK_MS === 0) {
        stepMotion(server, now === TICK_MS ? 0 : Math.PI / 2, false);
      }
      predictor.advance(now, Math.PI / 2, false);
      if (now % (TICK_MS * 2) !== 0) continue;

      const before = predictor.renderState();
      predictor.reconcile(snapshotOf(server), now / TICK_MS, now);
      const after = predictor.renderState();
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expectSamePose(before!, after!);
    }
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
    expect(head(predictor.renderState()!).x).toBe(200);
  });

  it("initializes a respawn from its new authoritative pose", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const original = initialMotion();
    predictor.reconcile(snapshotOf(original), 0, 0);
    predictor.advance(100, Math.PI / 2, true);

    predictor.reconcile({ ...snapshotOf(original), alive: false }, 2, 100);
    predictor.advance(150, Math.PI / 2, false);
    expect(predictor.renderState()).toBeUndefined();

    const respawned = initialMotion();
    respawned.body = [
      { x: 400, y: 300 },
      { x: 300, y: 300 },
    ];
    predictor.reconcile(snapshotOf(respawned), 3, 150);
    expectSameHead(respawned, predictor.renderState()!);
  });
});
