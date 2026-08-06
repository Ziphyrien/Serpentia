import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SKIN_ID } from "$lib/game/internal-skins";
import { normalGameDegreesToRadians } from "$lib/game/normal-game-math";
import { createBody, snakeMotionRules } from "$lib/game/snake-motion";
import type { ClientGameRules, SnakeSnapshot } from "$lib/protocol";
import { RemoteSnakePresentation } from "./remote-snake-presentation";

const TICK_RATE = 20;
const SNAKE_COUNT = 32;
const WARMUP_FRAMES = 120;
const MEASURED_FRAMES = 600;
const ROUNDS = 5;
const FRAME_MS = 1_000 / 60;
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
const LENGTHS = [80, 200, 1_000, 5_000] as const;

function snapshotFor(index: number, authoritativeTick: number): SnakeSnapshot {
  const length = LENGTHS[index % LENGTHS.length];
  const angleDegrees = (index * 23 + authoritativeTick * (index % 3 + 1) * 2) % 360;
  const angle = normalGameDegreesToRadians(angleDegrees);
  const x = -1_500 + index * 96 + authoritativeTick * (index % 2 === 0 ? 4.5 : 3);
  const y = Math.sin((authoritativeTick + index) * 0.08) * 180 + (index % 4) * 35;
  const boosting = index % 4 === 0;
  return {
    id: `remote-${index}`,
    nickname: `remote-${index}`,
    skinId: DEFAULT_SKIN_ID,
    body: createBody({ x, y }, angle, length, motion),
    angle,
    targetAngle: angle + normalGameDegreesToRadians(index % 3 === 0 ? 35 : 0),
    bodyScale: 1,
    length,
    score: length,
    kills: index % 5,
    boosting,
    alive: true,
    invulnerable: index % 7 === 0,
    respawnAtTick: null,
    lastInputSequence: -1,
    lastInputAppliedTick: authoritativeTick,
  };
}

function authorityFrames(): ReadonlyArray<ReadonlyArray<SnakeSnapshot>> {
  const maximumTick = Math.ceil((WARMUP_FRAMES + MEASURED_FRAMES) / 3) + 1;
  return Array.from({ length: maximumTick + 1 }, (_, tick) =>
    Array.from({ length: SNAKE_COUNT }, (_, index) => snapshotFor(index, tick)),
  );
}

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function runRound(frames: ReadonlyArray<ReadonlyArray<SnakeSnapshot>>): {
  elapsedMs: number;
  checksum: number;
  bodyPoints: number;
  outputs: number;
} {
  const presentation = new RemoteSnakePresentation(rules, TICK_RATE);
  let checksum = 0;
  let bodyPoints = 0;
  let outputs = 0;

  const runFrame = (frame: number): void => {
    const authoritativeTick = Math.floor(frame / 3);
    const presentationSourceFrame = authoritativeTick * motion.sourceFramesPerTick + (frame % 3) + 0.5;
    const snapshots = frames[authoritativeTick];
    if (snapshots === undefined) throw new Error(`Missing authority frame ${authoritativeTick}`);
    const presented = presentation.sample(
      snapshots,
      authoritativeTick,
      presentationSourceFrame,
      FRAME_MS,
      "self",
    );
    outputs += presented.length;
    for (let index = 0; index < presented.length; index += 1) {
      const snake = presented[index];
      bodyPoints += snake.body.length;
      const first = snake.body[0];
      const middle = snake.body[Math.floor(snake.body.length / 2)];
      const last = snake.body[snake.body.length - 1];
      if (first !== undefined) checksum += first.x * 0.000001 + first.y * 0.0000001;
      if (middle !== undefined) checksum += middle.x * 0.00000001 + middle.y * 0.000000001;
      if (last !== undefined) checksum += last.x * 0.000000001 + last.y * 0.0000000001;
      checksum += snake.angle * (index + 1) * 0.00000001;
    }
  };

  for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) runFrame(frame);
  checksum = 0;
  bodyPoints = 0;
  outputs = 0;
  const started = performance.now();
  for (let frame = WARMUP_FRAMES; frame < WARMUP_FRAMES + MEASURED_FRAMES; frame += 1) {
    runFrame(frame);
  }
  const elapsedMs = performance.now() - started;
  return { elapsedMs, checksum, bodyPoints, outputs };
}

describe("remote snake presentation benchmark", () => {
  it("measures the real headless remote presentation path", () => {
    const frames = authorityFrames();
    runRound(frames);

    const samples: number[] = [];
    let checksum = 0;
    let bodyPoints = 0;
    let outputs = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const result = runRound(frames);
      samples.push((result.elapsedMs * 1_000) / MEASURED_FRAMES);
      checksum += result.checksum;
      bodyPoints += result.bodyPoints;
      outputs += result.outputs;
    }

    const primary = median(samples);
    const sorted = [...samples].sort((left, right) => left - right);
    const p95 = sorted[sorted.length - 1] ?? Number.NaN;
    const minimum = sorted[0] ?? Number.NaN;
    expect(Number.isFinite(primary)).toBe(true);
    expect(outputs).toBe(SNAKE_COUNT * MEASURED_FRAMES * ROUNDS);
    expect(bodyPoints).toBeGreaterThan(outputs);
    expect(Number.isFinite(checksum)).toBe(true);

    console.log(`METRIC remote_snake_pipeline_us_per_frame=${primary.toFixed(3)}`);
    console.log(`METRIC remote_snake_pipeline_p95_us_per_frame=${p95.toFixed(3)}`);
    console.log(`METRIC remote_snake_pipeline_min_us_per_frame=${minimum.toFixed(3)}`);
    console.log(`METRIC remote_body_points_per_frame=${(bodyPoints / (MEASURED_FRAMES * ROUNDS)).toFixed(3)}`);
    console.log(`METRIC remote_snake_checksum=${checksum.toFixed(6)}`);
    console.log(`METRIC remote_output_count=${outputs}`);
  }, 120_000);
});
