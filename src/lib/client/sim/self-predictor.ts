import type { ClientGameRules, SnakeSnapshot } from "$lib/protocol";

interface Point {
  x: number;
  y: number;
}

interface PredictedStep {
  body: Array<Point>;
  angle: number;
  length: number;
}

const TAU = Math.PI * 2;

function normalizeAngle(angle: number): number {
  const normalized = ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return normalized === -Math.PI ? Math.PI : normalized;
}

function turnTowards(current: number, target: number, maximumTurn: number): number {
  const difference = normalizeAngle(target - current);
  if (Math.abs(difference) <= maximumTurn) return normalizeAngle(target);
  return normalizeAngle(current + Math.sign(difference) * maximumTurn);
}

/**
 * 自我蛇预测器：精确复刻服务端引擎的移动语义
 * （turnTowards + 匀速移动 + 按长度裁尾），
 * 在快照到达后回滚到权威状态并按服务端钟重放本地意图。
 * 渲染时在最近两个预测步之间插值，得到 60fps 的平滑手感。
 */
export class SelfPredictor {
  private previous: PredictedStep | undefined;
  private current: PredictedStep | undefined;
  private nextTickAt = 0;
  private tickMs: number;
  private boosting = false;
  private alive = false;

  constructor(
    private readonly rules: ClientGameRules,
    tickRate: number,
  ) {
    this.tickMs = 1000 / tickRate;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get currentLength(): number {
    return this.current?.length ?? 0;
  }

  /** 快照到达：回滚到权威状态，并把传输延迟期间的 ticks 立即补模拟。 */
  reconcile(snapshot: SnakeSnapshot, snapshotServerTime: number, serverNow: number): void {
    this.alive = snapshot.alive;
    if (!snapshot.alive) {
      this.previous = undefined;
      this.current = undefined;
      return;
    }
    this.boosting = snapshot.boosting;
    const state: PredictedStep = {
      body: snapshot.body.map((point) => ({ x: point.x, y: point.y })),
      angle: snapshot.angle,
      length: snapshot.length,
    };
    this.current = state;
    this.previous = {
      body: state.body.map((p) => ({ ...p })),
      angle: state.angle,
      length: state.length,
    };
    this.nextTickAt = snapshotServerTime + this.tickMs;
    // 补上 snapshot 生成到抵达之间流逝的 ticks（近似：使用当前意图）
    let guard = 0;
    while (this.nextTickAt <= serverNow && guard < 12) {
      this.step();
      guard += 1;
    }
    if (this.nextTickAt <= serverNow) this.nextTickAt = serverNow + this.tickMs;
  }

  /** 死亡后停止预测（等待重生快照）。 */
  markDead(): void {
    this.alive = false;
    this.previous = undefined;
    this.current = undefined;
  }

  /** 按服务端钟推进模拟；intent 为当前输入意图。 */
  advance(serverNow: number, intentAngle: number, intentBoosting: boolean): void {
    if (!this.alive || !this.current) return;
    let guard = 0;
    while (this.nextTickAt <= serverNow && guard < 8) {
      this.step(intentAngle, intentBoosting);
      guard += 1;
    }
  }

  /** 渲染帧：返回 prev/current 之间的插值系数与两步状态。 */
  renderState(
    serverNow: number,
  ): { from: PredictedStep; to: PredictedStep; alpha: number } | undefined {
    if (!this.current || !this.previous) return undefined;
    const alpha = Math.min(1, Math.max(0, 1 - (this.nextTickAt - serverNow) / this.tickMs));
    return { from: this.previous, to: this.current, alpha };
  }

  private step(intentAngle?: number, intentBoosting?: boolean): void {
    const current = this.current;
    if (!current) return;
    const secondsPerTick = this.tickMs / 1000;
    const maximumTurn = this.rules.turnRate * secondsPerTick;

    const angle =
      intentAngle === undefined
        ? current.angle
        : turnTowards(current.angle, intentAngle, maximumTurn);
    if (intentBoosting !== undefined) this.boosting = intentBoosting;

    const canBoost = this.boosting && current.length > this.rules.boostMinimumLength;
    const speed = canBoost ? this.rules.boostSpeed : this.rules.baseSpeed;

    const head: Point = {
      x: current.body[0].x + Math.cos(angle) * speed * secondsPerTick,
      y: current.body[0].y + Math.sin(angle) * speed * secondsPerTick,
    };

    let length = current.length;
    if (canBoost) {
      const drained = Math.min(
        this.rules.boostDrainPerSecond * secondsPerTick,
        length - this.rules.minimumLength,
      );
      length -= drained;
    }

    const body = [head, ...current.body.map((point) => ({ x: point.x, y: point.y }))];
    trimBody(body, length);

    this.previous = current;
    this.current = { body, angle, length };
    this.nextTickAt += this.tickMs;
  }
}

/** 与服务端 trimBody 等价：把折线裁剪到指定长度。 */
function trimBody(body: Array<Point>, length: number): void {
  let accumulated = 0;
  for (let index = 1; index < body.length; index += 1) {
    const previous = body[index - 1];
    const current = body[index];
    const segmentLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    if (accumulated + segmentLength < length) {
      accumulated += segmentLength;
      continue;
    }
    const remaining = Math.max(0, length - accumulated);
    const ratio = segmentLength === 0 ? 0 : remaining / segmentLength;
    body[index] = {
      x: previous.x + (current.x - previous.x) * ratio,
      y: previous.y + (current.y - previous.y) * ratio,
    };
    body.splice(index + 1);
    return;
  }
}
