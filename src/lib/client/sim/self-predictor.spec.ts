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

  it("corrects authoritative position without changing the local steering angle", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0);
    predictor.advance(120, Math.PI / 2, true);
    const before = predictor.renderState();
    expect(before).toBeDefined();

    // The server has not applied the local turn yet. Correct the matching tick's
    // position while preserving the responsive local angle.
    stepMotion(server, 0, false);
    const correction = predictor.reconcile(snapshotOf(server), 1, 120);
    const after = predictor.renderState();
    expect(correction).toBeDefined();
    expect(after).toBeDefined();
    expect(after!.angle).toBeCloseTo(before!.angle, 8);
    expect(head(after!).x - head(before!).x).toBeCloseTo(correction!.x, 8);
    expect(head(after!).y - head(before!).y).toBeCloseTo(correction!.y, 8);
  });

  it("keeps the fractional pose when authority is one tick ahead", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0);

    // The WebSocket callback runs just before the 50 ms fixed step. Rendering
    // is already 98% of the way to tick 1 even though tick 1 is not in history.
    predictor.advance(49, Math.PI / 2, false);
    const before = predictor.renderState();
    expect(before).toBeDefined();
    stepMotion(server, 0, false);

    const correction = predictor.reconcile(snapshotOf(server), 1, 49);
    const after = predictor.renderState();
    expect(correction?.mode).toBe("smooth");
    expect(after).toBeDefined();
    expect(after!.angle).toBeCloseTo(before!.angle, 8);
    expect(after!.body).toHaveLength(before!.body.length);
    for (let index = 0; index < before!.body.length; index += 1) {
      expect(after!.body[index].x - before!.body[index].x).toBeCloseTo(correction!.x, 8);
      expect(after!.body[index].y - before!.body[index].y).toBeCloseTo(correction!.y, 8);
    }
  });

  it("measures discontinuity recovery from the visible fractional head", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0);
    predictor.advance(49, Math.PI / 2, false);
    const before = predictor.renderState();
    expect(before).toBeDefined();

    for (let tick = 0; tick < 10; tick += 1) stepMotion(server, 0, false);
    const correction = predictor.reconcile(snapshotOf(server), 10, 49);
    const after = predictor.renderState();
    expect(correction?.mode).toBe("snap");
    expect(after).toBeDefined();
    expect(after!.angle).toBeCloseTo(before!.angle, 8);
    expect(head(after!).x - head(before!).x).toBeCloseTo(correction!.x, 8);
    expect(head(after!).y - head(before!).y).toBeCloseTo(correction!.y, 8);
  });

  it("does not rebuild the pose when each 10 Hz snapshot leads fixed history", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0);

    for (let snapshotIndex = 1; snapshotIndex <= 8; snapshotIndex += 1) {
      const now = snapshotIndex * 100 - 1;
      predictor.advance(now, Math.PI / 2, false);
      stepMotion(server, snapshotIndex === 1 ? 0 : Math.PI / 2, false);
      stepMotion(server, snapshotIndex === 1 ? 0 : Math.PI / 2, false);
      const before = predictor.renderState();
      const correction = predictor.reconcile(snapshotOf(server), snapshotIndex * 2, now);
      const after = predictor.renderState();
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expect(after!.angle).toBeCloseTo(before!.angle, 8);
      expect(after!.body).toHaveLength(before!.body.length);
      for (let index = 0; index < before!.body.length; index += 1) {
        expect(after!.body[index].x - before!.body[index].x).toBeCloseTo(correction?.x ?? 0, 8);
        expect(after!.body[index].y - before!.body[index].y).toBeCloseTo(correction?.y ?? 0, 8);
      }
    }
  });

  it("keeps repeated authoritative corrections from changing a continuous turn", () => {
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
      const correction = predictor.reconcile(snapshotOf(server), now / TICK_MS, now);
      const after = predictor.renderState();
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expect(after!.angle).toBeCloseTo(before!.angle, 8);
      if (correction) {
        expect(head(after!).x - head(before!).x).toBeCloseTo(correction.x, 8);
        expect(head(after!).y - head(before!).y).toBeCloseTo(correction.y, 8);
      }
    }
  });

  it("keeps food distance aligned with the authoritative head under delayed steering", () => {
    const predictor = new SelfPredictor(rules, TICK_RATE);
    const server = initialMotion();
    predictor.reconcile(snapshotOf(server), 0, 0);

    // Local steering starts immediately, while the server continues straight for
    // two ticks. This is the divergence that previously made visible food miss.
    predictor.advance(100, Math.PI / 2, false);
    stepMotion(server, 0, false);
    stepMotion(server, 0, false);
    const correction = predictor.reconcile(snapshotOf(server), 2, 100);
    const rendered = predictor.renderState();
    expect(correction).toBeDefined();
    expect(rendered).toBeDefined();
    expectSameHead(server, rendered!);
    expect(rendered!.angle).toBeGreaterThan(server.angle);

    const food = { x: head(server).x + 12, y: head(server).y - 4 };
    const serverDistance = Math.hypot(food.x - head(server).x, food.y - head(server).y);
    const renderedDistance = Math.hypot(food.x - head(rendered!).x, food.y - head(rendered!).y);
    expect(renderedDistance).toBeCloseTo(serverDistance, 8);
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
    const correction = predictor.reconcile(snapshotOf(farAway), 1, 50);
    expect(correction?.mode).toBe("snap");
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
