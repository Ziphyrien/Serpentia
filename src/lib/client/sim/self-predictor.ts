import type { ClientGameRules, SnakeSnapshot } from "$lib/protocol";
import {
  advanceSnakeMotion,
  trimBody,
  type MotionPoint,
  type SnakeMotionState,
} from "../../game/snake-motion";

interface InputIntent {
  readonly angle?: number;
  readonly boosting: boolean;
}

interface PredictedStep extends SnakeMotionState {
  tick: number;
}

export interface SelfRenderState {
  readonly body: ReadonlyArray<MotionPoint>;
  readonly angle: number;
  readonly boosting: boolean;
}

const MAX_FRAME_CATCH_UP_TICKS = 8;
const MAX_TICK_DRIFT = 40;

/**
 * Local prediction for the controlled snake.
 *
 * The controlled snake is intentionally rendered from a monotonic local clock.
 * Normal snapshots update authoritative metadata but do not rewind its visible
 * position: doing that makes network latency visible as a pull-back on every
 * fast turn. The server remains authoritative for collision, death, and respawn;
 * a large positional drift or a lifecycle transition reinitializes prediction.
 */
export class SelfPredictor {
  private current: PredictedStep | undefined;
  private readonly tickMs: number;
  private accumulatorMs = 0;
  private lastLocalTime: number | undefined;
  private latestIntent: InputIntent = { boosting: false };
  private alive = false;
  private readonly rebaseDistance: number;

  constructor(
    private readonly rules: ClientGameRules,
    tickRate: number,
  ) {
    this.tickMs = 1000 / tickRate;
    this.rebaseDistance = Math.max(80, rules.boostSpeed * 0.5);
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get currentLength(): number {
    return this.current?.length ?? 0;
  }

  /**
   * Incorporates an authoritative snapshot without rewinding normal movement.
   * `localNow` is monotonic browser time, deliberately independent of network
   * clock corrections used by remote-snake interpolation.
   */
  reconcile(snapshot: SnakeSnapshot, snapshotTick: number, localNow: number): void {
    if (!snapshot.alive) {
      this.reset();
      return;
    }

    if (!this.current || this.shouldRebase(snapshot, snapshotTick)) {
      this.initialize(snapshot, snapshotTick, localNow);
      return;
    }

    // Keep local steering responsive. Before the player supplies a direction,
    // the server's target is the only valid target to continue from.
    if (this.latestIntent.angle === undefined) {
      this.current.targetAngle = snapshot.targetAngle ?? snapshot.angle;
    }

    // Food and boost drain affect body length but should not rewind the head.
    if (Math.abs(this.current.length - snapshot.length) > 0.5) {
      this.current.length = snapshot.length;
      trimBody(this.current.body, this.current.length);
    }
  }

  /** Reinitializes local prediction after a new/reconnected session. */
  reset(): void {
    this.current = undefined;
    this.accumulatorMs = 0;
    this.lastLocalTime = undefined;
    this.latestIntent = { boosting: false };
    this.alive = false;
  }

  /** Stops prediction until an alive authoritative snapshot initializes it again. */
  markDead(): void {
    this.reset();
  }

  /** Advances fixed local ticks using the latest input intent. */
  advance(localNow: number, intentAngle: number | undefined, intentBoosting: boolean): void {
    this.latestIntent = { angle: intentAngle, boosting: intentBoosting };
    if (!this.alive || !this.current) {
      this.lastLocalTime = localNow;
      return;
    }

    if (this.lastLocalTime === undefined) this.lastLocalTime = localNow;
    const elapsed = Math.min(250, Math.max(0, localNow - this.lastLocalTime));
    this.lastLocalTime = localNow;
    this.accumulatorMs += elapsed;

    let processed = 0;
    while (this.accumulatorMs >= this.tickMs && processed < MAX_FRAME_CATCH_UP_TICKS) {
      applyIntent(this.current, this.latestIntent);
      advanceSnakeMotion(this.current, this.rules, this.tickMs / 1000);
      this.current.tick += 1;
      this.accumulatorMs -= this.tickMs;
      processed += 1;
    }

    // A backgrounded tab should rebase from the next authoritative snapshot,
    // rather than fast-forwarding several hundred ticks when it returns.
    if (this.accumulatorMs >= this.tickMs) this.accumulatorMs = 0;
  }

  /** Samples one fractional local tick ahead for smooth 60fps rendering. */
  renderState(): SelfRenderState | undefined {
    const current = this.current;
    if (!current) return undefined;

    const next = cloneStep(current, current.tick + 1);
    applyIntent(next, this.latestIntent);
    advanceSnakeMotion(next, this.rules, this.tickMs / 1000);
    const ratio = Math.min(1, Math.max(0, this.accumulatorMs / this.tickMs));
    return {
      body: interpolateBody(current.body, next.body, ratio),
      angle: interpolateAngle(current.angle, next.angle, ratio),
      boosting: next.boosting,
    };
  }

  private initialize(snapshot: SnakeSnapshot, snapshotTick: number, localNow: number): void {
    this.current = fromSnapshot(snapshot, snapshotTick);
    this.accumulatorMs = 0;
    this.lastLocalTime = localNow;
    this.alive = true;
  }

  private shouldRebase(snapshot: SnakeSnapshot, snapshotTick: number): boolean {
    const current = this.current;
    if (!current) return true;
    const currentHead = current.body[0];
    const snapshotHead = snapshot.body[0];
    if (!currentHead || !snapshotHead) return true;

    const distance = Math.hypot(currentHead.x - snapshotHead.x, currentHead.y - snapshotHead.y);
    const tickDrift = current.tick - snapshotTick;
    return distance > this.rebaseDistance || tickDrift < -4 || tickDrift > MAX_TICK_DRIFT;
  }
}

function fromSnapshot(snapshot: SnakeSnapshot, tick: number): PredictedStep {
  return {
    body: snapshot.body.map((point) => ({ x: point.x, y: point.y })),
    angle: snapshot.angle,
    targetAngle: snapshot.targetAngle ?? snapshot.angle,
    length: snapshot.length,
    boosting: snapshot.boosting,
    tick,
  };
}

function cloneStep(state: PredictedStep, tick: number): PredictedStep {
  return {
    body: state.body.map((point) => ({ ...point })),
    angle: state.angle,
    targetAngle: state.targetAngle,
    length: state.length,
    boosting: state.boosting,
    tick,
  };
}

function applyIntent(state: PredictedStep, intent: InputIntent): void {
  if (intent.angle !== undefined) state.targetAngle = intent.angle;
  state.boosting = intent.boosting;
}

function interpolateBody(
  from: ReadonlyArray<MotionPoint>,
  to: ReadonlyArray<MotionPoint>,
  ratio: number,
): Array<MotionPoint> {
  const pointCount = Math.max(from.length, to.length);
  const body: Array<MotionPoint> = [];
  for (let index = 0; index < pointCount; index += 1) {
    const before = from[Math.min(index, from.length - 1)];
    const after = to[Math.min(index, to.length - 1)];
    body.push({
      x: before.x + (after.x - before.x) * ratio,
      y: before.y + (after.y - before.y) * ratio,
    });
  }
  return body;
}

function interpolateAngle(from: number, to: number, ratio: number): number {
  const difference =
    ((((to - from + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
  return from + difference * ratio;
}
