import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SKIN_ID } from "$lib/game/internal-skins";
import { createBody, snakeMotionRules } from "$lib/game/snake-motion";
import type { ClientGameRules, GameSnapshot, SnakeSnapshot } from "$lib/protocol";
import { SelfPredictor } from "$lib/client/sim/self-predictor";
import { RemoteSnakePresentation } from "$lib/client/sim/remote-snake-presentation";
import { SnapshotBuffer } from "$lib/client/sim/snapshot-buffer";

const tickRate = 20;
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
  tickRate,
  minimumLength: rules.minimumLength,
  maximumLength: rules.maximumLength,
});

function snake(id: string, x: number): SnakeSnapshot {
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
    boosting: false,
    alive: true,
    invulnerable: false,
    respawnAtTick: null,
    lastInputSequence: -1,
    lastInputAppliedTick: 0,
  };
}

function snapshot(tick: number, selfX: number, remoteX: number): GameSnapshot {
  return {
    tick,
    snakes: [snake("self", selfX), snake("remote", remoteX)],
    foods: [],
    magnets: [],
    leaderboard: [],
  };
}

describe("client collision presentation timeline", () => {
  it("shows remote bodies at the same future frame as the local predicted head", () => {
    const first = snapshot(20, 0, 100);
    const latest = snapshot(22, 27, 127);
    const buffer = new SnapshotBuffer(() => "self");
    buffer.push(first, 1_000);
    buffer.push(latest, 1_100);

    const predictor = new SelfPredictor(rules, tickRate);
    predictor.reconcile(latest.snakes[0]!, latest.tick, 0);
    const selfState = predictor.renderState();
    expect(selfState).toBeDefined();

    const delayedRemote = buffer.sampleRemoteSnakes(960)[0];
    expect(delayedRemote?.body[0].x - selfState!.body[0].x).toBeCloseTo(46, 8);

    const remotePresentation = new RemoteSnakePresentation(rules, tickRate);
    const alignedRemote = remotePresentation.sample(
      latest.snakes,
      latest.tick,
      selfState!.presentationSourceFrame,
      0,
      "self",
    )[0];
    expect(alignedRemote?.body[0].x - selfState!.body[0].x).toBeCloseTo(100, 8);
  });
});
