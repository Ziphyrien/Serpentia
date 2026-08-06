import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SKIN_ID } from "$lib/game/internal-skins";
import { normalGameDegreesToRadians } from "$lib/game/normal-game-math";
import { createBody, snakeMotionRules } from "$lib/game/snake-motion";
import type { ClientGameRules, SnakeSnapshot } from "$lib/protocol";
import { SelfPredictor } from "./self-predictor";
import { RemoteSnakePresentation } from "./remote-snake-presentation";

const TICK_RATE = 20;
const rules: ClientGameRules = {
  arenaHalfSize: 2_448,
  initialLength: 80,
  minimumLength: 80,
  maximumLength: 100_000,
  eatDistanceFactor: 1.6,
  starFoodValue: 10,
  respawnDelayTicks: 30,
  respawnInvulnerabilityTicks: 60,
};
const motion = snakeMotionRules({
  tickRate: TICK_RATE,
  minimumLength: rules.minimumLength,
  maximumLength: rules.maximumLength,
});

function snake(id: string, x: number, boosting = false, length = 200): SnakeSnapshot {
  return {
    id,
    nickname: id,
    skinId: DEFAULT_SKIN_ID,
    body: createBody({ x, y: 0 }, 0, length, motion),
    angle: 0,
    targetAngle: 0,
    bodyScale: 1,
    length,
    score: length,
    kills: 0,
    boosting,
    alive: true,
    invulnerable: false,
    respawnAtTick: null,
    lastInputSequence: -1,
    lastInputAppliedTick: 0,
  };
}

describe("remote snake presentation", () => {
  it("advances remote snakes to the local prediction source frame", () => {
    const presentation = new RemoteSnakePresentation(rules, TICK_RATE);
    const authoritativeTick = 20;
    const targetSourceFrame = (authoritativeTick + 2) * motion.sourceFramesPerTick;

    const normal = presentation.sample(
      [snake("remote", 100)],
      authoritativeTick,
      targetSourceFrame,
      0,
      "self",
    )[0];
    expect(normal?.body[0].x).toBeCloseTo(127, 8);

    presentation.reset();
    const boosted = presentation.sample(
      [snake("remote", 100, true)],
      authoritativeTick,
      targetSourceFrame,
      0,
      "self",
    )[0];
    expect(boosted?.body[0].x).toBeCloseTo(154, 8);
  });

  it("predicts turning and fractional source frames with the shared motion model", () => {
    const presentation = new RemoteSnakePresentation(rules, TICK_RATE);
    const turning = { ...snake("remote", 0), targetAngle: normalGameDegreesToRadians(90) };
    const remote = presentation.sample([turning], 0, 1.5, 0, "self")[0];
    const firstAngle = normalGameDegreesToRadians(10);
    const secondAngle = normalGameDegreesToRadians(20);

    expect(remote?.body[0].x).toBeCloseTo(
      Math.cos(firstAngle) * 4.5 + Math.cos(secondAngle) * 2.25,
      8,
    );
    expect(remote?.body[0].y).toBeCloseTo(
      Math.sin(firstAngle) * 4.5 + Math.sin(secondAngle) * 2.25,
      8,
    );
    expect(remote?.angle).toBeCloseTo(normalGameDegreesToRadians(15), 8);
  });

  it("keeps self and remote snakes on one predicted timeline", () => {
    const authoritativeTick = 20;
    const selfSnapshot = snake("self", 0);
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(selfSnapshot, authoritativeTick, 0);
    const selfState = predictor.renderState();
    expect(selfState).toBeDefined();

    const presentation = new RemoteSnakePresentation(rules, TICK_RATE);
    const remote = presentation.sample(
      [selfSnapshot, snake("remote", 100)],
      authoritativeTick,
      selfState!.presentationSourceFrame,
      0,
      "self",
    )[0];
    expect(remote?.body[0].x - selfState!.body[0].x).toBeCloseTo(100, 8);
  });

  it("preserves relative positions through the local Hermite turn presentation", () => {
    const authoritativeTick = 20;
    const targetAngle = normalGameDegreesToRadians(90);
    const selfSnapshot = { ...snake("self", 0), targetAngle };
    const remoteSnapshot = { ...snake("remote", 100), targetAngle };
    const predictor = new SelfPredictor(rules, TICK_RATE);
    predictor.reconcile(selfSnapshot, authoritativeTick, 0);
    predictor.advance(25);
    const selfState = predictor.renderState();
    expect(selfState).toBeDefined();

    const presentation = new RemoteSnakePresentation(rules, TICK_RATE);
    const remote = presentation.sample(
      [selfSnapshot, remoteSnapshot],
      authoritativeTick,
      selfState!.presentationSourceFrame,
      25,
      "self",
    )[0];
    expect(Math.abs((remote?.body[0].x ?? 0) - selfState!.body[0].x - 100)).toBeLessThan(0.5);
    expect(Math.abs((remote?.body[0].y ?? 0) - selfState!.body[0].y)).toBeLessThan(0.5);
  });

  it("follows regular movement while spreading authority corrections", () => {
    const presentation = new RemoteSnakePresentation(rules, TICK_RATE);
    const remote = snake("remote", 0);
    expect(presentation.sample([remote], 0, 0, 0, "self")[0]?.body[0].x).toBe(0);

    for (let sourceFrame = 1; sourceFrame <= 3; sourceFrame += 1) {
      const regular = presentation.sample([remote], 0, sourceFrame, 1_000 / 60, "self")[0];
      expect(regular?.body[0].x).toBeCloseTo(sourceFrame * 4.5, 8);
    }

    const corrected = presentation.sample([snake("remote", 40)], 1, 4, 1_000 / 60, "self")[0];
    expect(corrected?.body[0].x).toBeCloseTo(22.5, 8);
  });

  it("keeps integer-frame views detached from later motion updates", () => {
    const presentation = new RemoteSnakePresentation(rules, TICK_RATE);
    const remote = snake("remote", 0);
    const first = presentation.sample([remote], 0, 0, 0, "self")[0];
    expect(first).toBeDefined();
    const firstBody = first!.body.map((point) => ({ ...point }));

    presentation.sample([remote], 0, 2.5, 1_000 / 60, "self");
    expect(first!.body).toEqual(firstBody);
  });

  it("reuses fractional state across body-size changes without stale points", () => {
    const presentation = new RemoteSnakePresentation(rules, TICK_RATE);
    const lengths = [80, 83, 86, 80];

    for (let authoritativeTick = 0; authoritativeTick < lengths.length; authoritativeTick += 1) {
      const remote = snake("remote", 0, false, lengths[authoritativeTick]);
      const sourceFrame = authoritativeTick * motion.sourceFramesPerTick + 0.5;
      const continued = presentation.sample(
        [remote],
        authoritativeTick,
        sourceFrame,
        100,
        "self",
      )[0];
      const fresh = new RemoteSnakePresentation(rules, TICK_RATE).sample(
        [remote],
        authoritativeTick,
        sourceFrame,
        100,
        "self",
      )[0];

      expect(continued?.body).toHaveLength(fresh?.body.length ?? 0);
      expect(continued?.angle).toBeCloseTo(fresh?.angle ?? 0, 8);
      for (let index = 0; index < (fresh?.body.length ?? 0); index += 1) {
        expect(continued?.body[index]?.x).toBeCloseTo(fresh?.body[index]?.x ?? 0, 8);
        expect(continued?.body[index]?.y).toBeCloseTo(fresh?.body[index]?.y ?? 0, 8);
      }
    }
  });

  it("keeps aligned fractional scratch equivalent across jumps and resets", () => {
    const presentation = new RemoteSnakePresentation(rules, TICK_RATE);
    const sequence = [
      { authoritativeTick: 0, sourceFrame: 0, skinId: DEFAULT_SKIN_ID },
      { authoritativeTick: 0, sourceFrame: 0.5, skinId: DEFAULT_SKIN_ID },
      { authoritativeTick: 0, sourceFrame: 1.5, skinId: DEFAULT_SKIN_ID },
      { authoritativeTick: 0, sourceFrame: 3, skinId: DEFAULT_SKIN_ID },
      { authoritativeTick: 0, sourceFrame: 4.5, skinId: DEFAULT_SKIN_ID },
      { authoritativeTick: 1, sourceFrame: 3.5, skinId: DEFAULT_SKIN_ID + 1 },
      { authoritativeTick: 1, sourceFrame: 4, skinId: DEFAULT_SKIN_ID + 1 },
      { authoritativeTick: 2, sourceFrame: 7.5, skinId: DEFAULT_SKIN_ID },
    ];

    for (const sample of sequence) {
      const remote = { ...snake("remote", 0), skinId: sample.skinId };
      const actual = presentation.sample(
        [remote],
        sample.authoritativeTick,
        sample.sourceFrame,
        100,
        "self",
      )[0];
      const expected = new RemoteSnakePresentation(rules, TICK_RATE).sample(
        [remote],
        sample.authoritativeTick,
        sample.sourceFrame,
        100,
        "self",
      )[0];

      expect(actual?.body).toHaveLength(expected?.body.length ?? 0);
      expect(actual?.angle).toBeCloseTo(expected?.angle ?? 0, 8);
      for (let index = 0; index < (expected?.body.length ?? 0); index += 1) {
        expect(actual?.body[index]?.x).toBeCloseTo(expected?.body[index]?.x ?? 0, 8);
        expect(actual?.body[index]?.y).toBeCloseTo(expected?.body[index]?.y ?? 0, 8);
      }
    }
  });

  it("clears a large authority correction before resuming regular motion", () => {
    const presentation = new RemoteSnakePresentation(rules, TICK_RATE);
    const initial = snake("remote", 0);
    const corrected = snake("remote", 1_000);
    presentation.sample([initial], 0, 0, 0, "self");
    presentation.sample([corrected], 1, 3, 100, "self");

    let actual: ReturnType<RemoteSnakePresentation["sample"]>[number] | undefined;
    for (let sourceFrame = 4; sourceFrame <= 60; sourceFrame += 1) {
      actual = presentation.sample([corrected], 1, sourceFrame, 100, "self")[0];
    }
    const expected = new RemoteSnakePresentation(rules, TICK_RATE).sample(
      [corrected],
      1,
      60,
      100,
      "self",
    )[0];

    expect(actual?.body).toHaveLength(expected?.body.length ?? 0);
    for (let index = 0; index < (expected?.body.length ?? 0); index += 1) {
      expect(actual?.body[index]?.x).toBeCloseTo(expected?.body[index]?.x ?? 0, 8);
      expect(actual?.body[index]?.y).toBeCloseTo(expected?.body[index]?.y ?? 0, 8);
    }
  });

  it("rebuilds reused state across large authority body-size changes", () => {
    const presentation = new RemoteSnakePresentation(rules, TICK_RATE);
    for (const [authoritativeTick, length] of [80, 5_000, 80].entries()) {
      const remote = snake("remote", 0, false, length);
      const presented = presentation.sample(
        [remote],
        authoritativeTick,
        authoritativeTick * motion.sourceFramesPerTick + 0.5,
        0,
        "self",
      )[0];
      const expectedLength = createBody({ x: 0, y: 0 }, 0, length, motion).length;
      expect(presented?.body).toHaveLength(expectedLength);
      expect(presented?.body.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    }
  });

  it("drops dead, local, and stale remote entries", () => {
    const presentation = new RemoteSnakePresentation(rules, TICK_RATE);
    const remote = snake("remote", 0);
    expect(presentation.sample([snake("self", 0), remote], 0, 0, 0, "self")).toHaveLength(1);
    expect(presentation.sample([{ ...remote, alive: false }], 0, 0, 0, "self")).toHaveLength(0);
    expect(presentation.sample([remote], 0, 0, 0, "remote")).toHaveLength(0);
  });
});
