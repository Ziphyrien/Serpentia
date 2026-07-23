import type { ClientGameRules, SnakeSnapshot } from "$lib/protocol";

interface Point {
  x: number;
  y: number;
}

interface PredictedStep {
  body: Array<Point>;
  angle: number;
  length: number;
  /** 该步对应的服务端 tick 时刻（服务器时钟，毫秒）。 */
  tickAt: number;
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

  /**
   * 快照到达：回滚到权威状态，并用当前意图把传输延迟期间的 ticks 补模拟。
   *
   * 平滑的关键在 0 次补模拟的场景（低延迟下快照往返不足一个 tick，
   * 是常态）：若把 previous/current 重置成同一份，渲染插值会一直停在
   * 快照位置直到下一个 tick——每个快照周期都是「拽回→冻结→追赶」，
   * 整条蛇 10Hz 前后抽搐。此时从本地预测历史里挑出正好落在上一 tick
   * 的那一步作 previous，权威修正就能在一个 tick 的插值窗口内平滑收敛。
   * （这也解释了抽搐为何时有时无：有效延迟 = 单程延迟 + 时钟偏移误差，
   * 偏移随 ping 采样缓慢漂移，漂过 tick 边界时补模拟次数在 0/1 间切换，
   * 两种表现随之交替。）
   */
  reconcile(
    snapshot: SnakeSnapshot,
    snapshotServerTime: number,
    serverNow: number,
    intentAngle?: number,
    intentBoosting?: boolean,
  ): void {
    this.alive = snapshot.alive;
    if (!snapshot.alive) {
      this.previous = undefined;
      this.current = undefined;
      return;
    }
    this.boosting = snapshot.boosting;
    const oldPrevious = this.previous;
    const oldCurrent = this.current;
    const state: PredictedStep = {
      body: snapshot.body.map((point) => ({ x: point.x, y: point.y })),
      angle: snapshot.angle,
      length: snapshot.length,
      tickAt: snapshotServerTime,
    };
    this.current = state;
    this.nextTickAt = snapshotServerTime + this.tickMs;
    // 补上 snapshot 生成到抵达之间流逝的 ticks（用当前意图回放；旧代码
    // 用快照的旧角度，转弯时每次快照都把蛇头拽回旧轨迹）。
    // 每次 step 都会自然把 previous 前移一格，≥1 次时无需特殊处理。
    let guard = 0;
    while (this.nextTickAt <= serverNow && guard < 12) {
      this.step(intentAngle, intentBoosting);
      guard += 1;
    }
    if (this.nextTickAt <= serverNow) this.nextTickAt = serverNow + this.tickMs;
    if (guard === 0) {
      const wanted = snapshotServerTime - this.tickMs;
      const tolerance = this.tickMs * 0.5;
      let previous: PredictedStep | undefined;
      if (oldPrevious && Math.abs(oldPrevious.tickAt - wanted) <= tolerance) {
        previous = oldPrevious;
      } else if (oldCurrent && Math.abs(oldCurrent.tickAt - wanted) <= tolerance) {
        previous = oldCurrent;
      } else {
        // 预测历史对不上（首次快照、时钟重同步等），退化为原地冻结一个 tick
        previous = {
          body: state.body.map((p) => ({ ...p })),
          angle: state.angle,
          length: state.length,
          tickAt: wanted,
        };
      }
      this.previous = previous;
    }
  }

  /** 死亡后停止预测（等待重生快照）。 */
  markDead(): void {
    this.alive = false;
    this.previous = undefined;
    this.current = undefined;
  }

  /** 按服务端钟推进模拟；intent 为当前输入意图（无方向输入时 angle 传 undefined）。 */
  advance(serverNow: number, intentAngle?: number, intentBoosting?: boolean): void {
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
    this.current = { body, angle, length, tickAt: this.nextTickAt };
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
