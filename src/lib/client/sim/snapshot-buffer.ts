import type { FoodState, GameSnapshot, MagnetToolState, SnakeSnapshot } from "$lib/protocol";
import { STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME } from "$lib/game/food-metrics";
import { SNAKE_MOTION } from "$lib/game/snake-motion";
import { RENDER } from "../config";

/** 渲染用的一帧远端蛇插值视图（纯数据，不含渲染对象）。 */
export interface InterpolatedSnake {
  readonly id: string;
  readonly nickname: string;
  /** 权威皮肤 ID；与体型一样保持离散值，不做插值。 */
  readonly skinId: number;
  readonly body: ReadonlyArray<{ x: number; y: number }>;
  readonly angle: number;
  /** 当前权威身体缩放档位；档位跳变不能做连续插值。 */
  readonly bodyScale: number;
  readonly length: number;
  readonly boosting: boolean;
  readonly alive: boolean;
  readonly invulnerable: boolean;
  readonly magnetUntilSourceFrame: number | null;
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

  /**
   * 返回远端画面当前对应的权威 tick（可含小数）。
   * 与蛇插值使用同一组快照和时间边界，供离散事件映射到呈现时间轴。
   */
  presentationTick(renderServerTime: number): number | undefined {
    if (this.frames.length === 0) return undefined;
    const upperIndex = this.frames.findIndex((frame) => frame.serverTime >= renderServerTime);
    if (upperIndex === 0) return this.frames[0].snapshot.tick;
    if (upperIndex === -1) return this.frames[this.frames.length - 1].snapshot.tick;

    const before = this.frames[upperIndex - 1];
    const after = this.frames[upperIndex];
    const span = after.serverTime - before.serverTime;
    if (span <= 0) return after.snapshot.tick;
    const ratio = Math.min(1, Math.max(0, (renderServerTime - before.serverTime) / span));
    return before.snapshot.tick + (after.snapshot.tick - before.snapshot.tick) * ratio;
  }

  /**
   * 在与远端蛇相同的权威时间轴上采样食物。
   * 连续小位移用于星星平滑；安全重生等大跳变只在上界快照时切换。
   */
  sampleFoods(renderServerTime: number): Array<FoodState> {
    if (this.frames.length === 0) return [];

    const upperIndex = this.frames.findIndex((frame) => frame.serverTime >= renderServerTime);
    if (upperIndex === 0) return cloneFoods(this.frames[0].snapshot.foods);
    if (upperIndex === -1) return cloneFoods(this.frames[this.frames.length - 1].snapshot.foods);

    const before = this.frames[upperIndex - 1];
    const after = this.frames[upperIndex];
    const span = after.serverTime - before.serverTime;
    if (span <= 0) return cloneFoods(after.snapshot.foods);
    const ratio = Math.min(1, Math.max(0, (renderServerTime - before.serverTime) / span));
    return interpolateFoods(before.snapshot.foods, after.snapshot.foods, ratio, span);
  }

  /** 在远端权威时间轴上平滑地图磁铁；生成、拾取和消失只在上界切换。 */
  sampleMagnets(renderServerTime: number): Array<MagnetToolState> {
    if (this.frames.length === 0) return [];
    const upperIndex = this.frames.findIndex((frame) => frame.serverTime >= renderServerTime);
    if (upperIndex === 0) return cloneMagnets(this.frames[0].snapshot.magnets ?? []);
    if (upperIndex === -1) {
      return cloneMagnets(this.frames[this.frames.length - 1].snapshot.magnets ?? []);
    }
    const before = this.frames[upperIndex - 1];
    const after = this.frames[upperIndex];
    const span = after.serverTime - before.serverTime;
    if (span <= 0) return cloneMagnets(after.snapshot.magnets ?? []);
    const ratio = Math.min(1, Math.max(0, (renderServerTime - before.serverTime) / span));
    return interpolateMagnets(before.snapshot.magnets ?? [], after.snapshot.magnets ?? [], ratio);
  }

  /** Samples remote snakes at a server timestamp, excluding the locally predicted snake. */
  sampleRemoteSnakes(renderServerTime: number): Array<InterpolatedSnake> {
    if (this.frames.length === 0) return [];

    const upperIndex = this.frames.findIndex((frame) => frame.serverTime >= renderServerTime);
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

function cloneMagnets(magnets: ReadonlyArray<MagnetToolState>): Array<MagnetToolState> {
  return magnets.map((magnet) => ({ ...magnet, position: { ...magnet.position } }));
}

function interpolateMagnets(
  before: ReadonlyArray<MagnetToolState>,
  after: ReadonlyArray<MagnetToolState>,
  ratio: number,
): Array<MagnetToolState> {
  if (ratio <= 0) return cloneMagnets(before);
  if (ratio >= 1) return cloneMagnets(after);
  const afterById = new Map(after.map((magnet) => [magnet.id, magnet]));
  const result: Array<MagnetToolState> = [];
  for (const magnet of before) {
    const next = afterById.get(magnet.id);
    if (next === undefined) {
      result.push({ ...magnet, position: { ...magnet.position } });
      continue;
    }
    result.push({
      ...magnet,
      position: {
        x: magnet.position.x + (next.position.x - magnet.position.x) * ratio,
        y: magnet.position.y + (next.position.y - magnet.position.y) * ratio,
      },
    });
  }
  return result;
}

function cloneFoods(foods: ReadonlyArray<FoodState>): Array<FoodState> {
  return foods.map((food) => ({ ...food, position: { ...food.position } }));
}

function interpolateFoods(
  before: ReadonlyArray<FoodState>,
  after: ReadonlyArray<FoodState>,
  ratio: number,
  spanMs: number,
): Array<FoodState> {
  if (ratio <= 0) return cloneFoods(before);
  if (ratio >= 1) return cloneFoods(after);

  const afterById = new Map(after.map((food) => [food.id, food]));
  const maxContinuousDistance =
    STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME *
      (SNAKE_MOTION.sourceFrameRate * (spanMs / 1000) + 1) +
    1;
  const result: Array<FoodState> = [];
  for (const food of before) {
    const next = afterById.get(food.id);
    if (next === undefined || !sameFoodGeneration(food, next)) {
      result.push({ ...food, position: { ...food.position } });
      continue;
    }

    const dx = next.position.x - food.position.x;
    const dy = next.position.y - food.position.y;
    if (Math.hypot(dx, dy) > maxContinuousDistance) {
      result.push({ ...food, position: { ...food.position } });
      continue;
    }
    result.push({
      ...food,
      position: {
        x: food.position.x + dx * ratio,
        y: food.position.y + dy * ratio,
      },
    });
  }
  return result;
}

function sameFoodGeneration(left: FoodState, right: FoodState): boolean {
  return (
    left.kind === right.kind &&
    left.value === right.value &&
    left.lengthValue === right.lengthValue &&
    left.variant === right.variant &&
    left.generation === right.generation
  );
}

function toView(snake: SnakeSnapshot): InterpolatedSnake {
  return {
    id: snake.id,
    nickname: snake.nickname,
    skinId: snake.skinId,
    body: snake.body,
    angle: snake.angle,
    bodyScale: snake.bodyScale,
    length: snake.length,
    boosting: snake.boosting,
    alive: snake.alive,
    invulnerable: snake.invulnerable,
    magnetUntilSourceFrame: snake.magnetUntilSourceFrame ?? null,
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
    skinId: ratio < 1 ? from.skinId : to.skinId,
    body,
    angle: from.angle + angleDelta * ratio,
    // 原版体型按档位跳变；在上一个权威时刻结束前保持旧档位。
    bodyScale: ratio < 1 ? from.bodyScale : to.bodyScale,
    length: from.length + (to.length - from.length) * ratio,
    boosting: to.boosting,
    alive: to.alive,
    invulnerable: to.invulnerable,
    magnetUntilSourceFrame:
      ratio < 1 ? (from.magnetUntilSourceFrame ?? null) : (to.magnetUntilSourceFrame ?? null),
  };
}
