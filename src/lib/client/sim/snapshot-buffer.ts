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

/**
 * 快照环形缓冲：保留最近两帧权威快照，
 * 按「服务端时间 - 插值延迟」采样出平滑的远端世界视图。
 */
export class SnapshotBuffer {
  private previous: GameSnapshot | undefined;
  private latest: GameSnapshot | undefined;
  private previousAt = 0;
  private latestAt = 0;

  constructor(private readonly selfId: () => string | undefined) {}

  push(snapshot: GameSnapshot, serverTime: number): void {
    this.previous = this.latest;
    this.previousAt = this.latestAt;
    this.latest = snapshot;
    this.latestAt = serverTime;
  }

  get latestSnapshot(): GameSnapshot | undefined {
    return this.latest;
  }

  /** 估算当前应使用的插值延迟（自适应快照间隔）。 */
  interpolationDelay(): number {
    const interval = this.latestAt - this.previousAt;
    if (interval <= 0 || interval > 1000) return RENDER.minInterpolationDelayMs;
    return Math.min(
      RENDER.maxInterpolationDelayMs,
      Math.max(RENDER.minInterpolationDelayMs, interval * RENDER.interpolationDelayFactor),
    );
  }

  /**
   * 采样 renderServerTime 时刻的远端蛇（不含自己，自己走预测通道）。
   */
  sampleRemoteSnakes(renderServerTime: number): Array<InterpolatedSnake> {
    const latest = this.latest;
    if (!latest) return [];
    const selfId = this.selfId();
    const previous = this.previous;
    const span = this.latestAt - this.previousAt;
    const ratio =
      previous && span > 0
        ? Math.min(1.25, Math.max(0, (renderServerTime - this.previousAt) / span))
        : 1;

    const result: Array<InterpolatedSnake> = [];
    for (const snake of latest.snakes) {
      if (snake.id === selfId) continue;
      if (!snake.alive) continue;
      const before = previous?.snakes.find((candidate) => candidate.id === snake.id);
      if (!before || !before.alive || ratio >= 1) {
        result.push(toView(snake));
        continue;
      }
      result.push(lerpSnake(before, snake, ratio));
    }
    return result;
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
