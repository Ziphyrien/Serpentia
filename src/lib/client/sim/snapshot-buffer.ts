import type { GameSnapshot, SnakeSnapshot } from "$lib/protocol";
import { RENDER } from "../config";

/** 渲染用的一帧远端蛇插值视图（纯数据，不含渲染对象）。 */
export interface InterpolatedSnake {
  readonly id: string;
  readonly nickname: string;
  readonly body: ReadonlyArray<{ x: number; y: number }>;
  readonly angle: number;
  readonly radius: number;
  readonly length: number;
  readonly boosting: boolean;
  readonly alive: boolean;
  readonly invulnerable: boolean;
}

interface BufferedSnapshot {
  readonly snapshot: GameSnapshot;
  readonly serverTime: number;
}

const MAX_BUFFERED_SNAPSHOTS = 8;
const INTERVAL_SAMPLE_COUNT = 5;

/**
 * Time-ordered authoritative snapshot buffer for remote players.
 *
 * The interpolation delay can exceed one snapshot interval, so retaining only
 * the latest pair is insufficient: replacing that pair moves the lower bound
 * forward and causes a visible jump. This buffer keeps enough history to select
 * the two frames that actually bracket the requested render time.
 */
export class SnapshotBuffer {
  private readonly frames: Array<BufferedSnapshot> = [];

  constructor(private readonly selfId: () => string | undefined) {}

  push(snapshot: GameSnapshot, serverTime: number): void {
    const latest = this.frames[this.frames.length - 1];
    if (latest && serverTime < latest.serverTime) return;
    if (latest?.serverTime === serverTime) {
      this.frames[this.frames.length - 1] = { snapshot, serverTime };
      return;
    }
    this.frames.push({ snapshot, serverTime });
    if (this.frames.length > MAX_BUFFERED_SNAPSHOTS) this.frames.shift();
  }

  reset(): void {
    this.frames.length = 0;
  }

  get latestSnapshot(): GameSnapshot | undefined {
    return this.frames[this.frames.length - 1]?.snapshot;
  }

  /** Uses the median recent interval so an urgent snapshot does not collapse the delay. */
  interpolationDelay(): number {
    if (this.frames.length < 2) return RENDER.minInterpolationDelayMs;
    const intervals: Array<number> = [];
    const start = Math.max(1, this.frames.length - INTERVAL_SAMPLE_COUNT);
    for (let index = start; index < this.frames.length; index += 1) {
      const interval = this.frames[index].serverTime - this.frames[index - 1].serverTime;
      if (interval > 0 && interval <= 1000) intervals.push(interval);
    }
    if (intervals.length === 0) return RENDER.minInterpolationDelayMs;
    intervals.sort((left, right) => left - right);
    const middle = Math.floor(intervals.length / 2);
    const interval =
      intervals.length % 2 === 0
        ? (intervals[middle - 1] + intervals[middle]) / 2
        : intervals[middle];
    return Math.min(
      RENDER.maxInterpolationDelayMs,
      Math.max(RENDER.minInterpolationDelayMs, interval * RENDER.interpolationDelayFactor),
    );
  }

  /** Samples remote snakes at a server timestamp, excluding the locally predicted snake. */
  sampleRemoteSnakes(renderServerTime: number): Array<InterpolatedSnake> {
    if (this.frames.length === 0) return [];

    let upperIndex = this.frames.findIndex((frame) => frame.serverTime >= renderServerTime);
    if (upperIndex === 0) return this.viewsFrom(this.frames[0].snapshot);
    if (upperIndex === -1) return this.viewsFrom(this.frames[this.frames.length - 1].snapshot);

    const before = this.frames[upperIndex - 1];
    const after = this.frames[upperIndex];
    const span = after.serverTime - before.serverTime;
    if (span <= 0) return this.viewsFrom(after.snapshot);
    const ratio = Math.min(1, Math.max(0, (renderServerTime - before.serverTime) / span));
    const beforeById = new Map(before.snapshot.snakes.map((snake) => [snake.id, snake]));
    const selfId = this.selfId();
    const result: Array<InterpolatedSnake> = [];

    for (const snake of after.snapshot.snakes) {
      if (snake.id === selfId || !snake.alive) continue;
      const previous = beforeById.get(snake.id);
      result.push(previous?.alive ? lerpSnake(previous, snake, ratio) : toView(snake));
    }
    return result;
  }

  private viewsFrom(snapshot: GameSnapshot): Array<InterpolatedSnake> {
    const selfId = this.selfId();
    return snapshot.snakes
      .filter((snake) => snake.id !== selfId && snake.alive)
      .map((snake) => toView(snake));
  }
}

function toView(snake: SnakeSnapshot): InterpolatedSnake {
  return {
    id: snake.id,
    nickname: snake.nickname,
    body: snake.body,
    angle: snake.angle,
    radius: snake.radius,
    length: snake.length,
    boosting: snake.boosting,
    alive: snake.alive,
    invulnerable: snake.invulnerable,
  };
}

function lerpSnake(from: SnakeSnapshot, to: SnakeSnapshot, ratio: number): InterpolatedSnake {
  const maxLength = Math.max(from.body.length, to.body.length);
  const body: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < maxLength; index += 1) {
    const a = from.body[Math.min(index, from.body.length - 1)];
    const b = to.body[Math.min(index, to.body.length - 1)];
    body.push({ x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio });
  }
  let angleDelta = to.angle - from.angle;
  while (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
  while (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
  return {
    id: to.id,
    nickname: to.nickname,
    body,
    angle: from.angle + angleDelta * ratio,
    radius: from.radius + (to.radius - from.radius) * ratio,
    length: from.length + (to.length - from.length) * ratio,
    boosting: to.boosting,
    alive: to.alive,
    invulnerable: to.invulnerable,
  };
}
