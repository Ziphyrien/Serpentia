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

function snake(id: string, x: number, boosting = false): SnakeSnapshot {
  const length = 200;
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

  it("drops dead, local, and stale remote entries", () => {
    const presentation = new RemoteSnakePresentation(rules, TICK_RATE);
    const remote = snake("remote", 0);
    expect(presentation.sample([snake("self", 0), remote], 0, 0, 0, "self")).toHaveLength(1);
    expect(presentation.sample([{ ...remote, alive: false }], 0, 0, 0, "self")).toHaveLength(0);
    expect(presentation.sample([remote], 0, 0, 0, "remote")).toHaveLength(0);
  });
});
