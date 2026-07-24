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

export interface SelfPositionCorrection {
  readonly x: number;
  readonly y: number;
}

const MAX_FRAME_CATCH_UP_TICKS = 8;
const MAX_AUTHORITY_LEAD_TICKS = 4;
const POSITION_HISTORY_TICKS = 64;
const MINIMUM_CORRECTION_SQUARED = 1e-8;

/**
 * Local prediction for the controlled snake.
 *
 * Movement and steering advance from a monotonic local clock. Recent predicted
 * heads are retained by server tick so an authoritative snapshot can correct
 * the same point in time. Reconciliation translates the predicted body without
 * replacing its local angle; the renderer applies the same translation to the
 * camera, keeping steering visually continuous while restoring the authoritative
 * head-to-food coordinate relationship.
 */
export class SelfPredictor {
  private current: PredictedStep | undefined;
  private readonly tickMs: number;
  private accumulatorMs = 0;
  private lastLocalTime: number | undefined;
  private latestIntent: InputIntent = { boosting: false };
  private alive = false;
  private readonly headByTick = new Map<number, MotionPoint>();
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
   * Aligns local position with the authoritative state at the same server tick.
   * The returned translation must also be applied to the camera in the same
   * turn, otherwise a correct reconciliation would look like a head snap.
   */
  reconcile(
    snapshot: SnakeSnapshot,
    snapshotTick: number,
    localNow: number,
  ): SelfPositionCorrection | undefined {
    const snapshotHead = snapshot.body[0];
    if (!snapshot.alive || !snapshotHead) {
      this.reset();
      return undefined;
    }

    const current = this.current;
    if (!current) {
      this.initialize(snapshot, snapshotTick, localNow);
      return undefined;
    }

    const recordedHead = this.headByTick.get(snapshotTick);
    const predictedAtSnapshot = recordedHead ?? this.projectHead(snapshotTick);
    const predictedCorrection = predictedAtSnapshot
      ? {
          x: snapshotHead.x - predictedAtSnapshot.x,
          y: snapshotHead.y - predictedAtSnapshot.y,
        }
      : undefined;
    let correction: SelfPositionCorrection | undefined;

    if (
      predictedCorrection &&
      Math.hypot(predictedCorrection.x, predictedCorrection.y) <= this.rebaseDistance
    ) {
      correction = predictedCorrection;
      // A snapshot commonly arrives just before the render ticker completes the
      // same local tick. Projecting that tick and translating the existing pose
      // keeps the fractional render phase intact instead of rebuilding at 10 Hz.
      this.translatePrediction(correction, Math.min(snapshotTick, current.tick));
      if (recordedHead) {
        this.headByTick.set(snapshotTick, { x: snapshotHead.x, y: snapshotHead.y });
      }
    } else {
      // A suspended tab or a long snapshot gap can move the authoritative tick
      // outside retained history. Rebuild from authority, but compensate using
      // the actually rendered fractional pose rather than the last fixed tick.
      const visibleBefore = this.renderState();
      const localAngle = visibleBefore?.angle ?? current.angle;
      const localTargetAngle = current.targetAngle;
      this.initialize(snapshot, snapshotTick, localNow);
      if (this.latestIntent.angle !== undefined && this.current) {
        this.current.angle = localAngle;
        this.current.targetAngle = localTargetAngle;
      }
      const beforeHead = visibleBefore?.body[0];
      const afterHead = this.renderState()?.body[0];
      correction =
        beforeHead && afterHead
          ? { x: afterHead.x - beforeHead.x, y: afterHead.y - beforeHead.y }
          : undefined;
    }

    const reconciled = this.current;
    if (!reconciled) return meaningfulCorrection(correction);

    if (this.latestIntent.angle === undefined) {
      reconciled.targetAngle = snapshot.targetAngle ?? snapshot.angle;
    }

    // Length changes only trim or extend the future path. They never move the
    // head; positional authority is handled explicitly above.
    if (Math.abs(reconciled.length - snapshot.length) > 0.5) {
      reconciled.length = snapshot.length;
      trimBody(reconciled.body, reconciled.length);
    }

    return meaningfulCorrection(correction);
  }

  /** Reinitializes local prediction after a new/reconnected session. */
  reset(): void {
    this.current = undefined;
    this.accumulatorMs = 0;
    this.lastLocalTime = undefined;
    this.latestIntent = { boosting: false };
    this.alive = false;
    this.headByTick.clear();
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
      this.recordCurrentHead();
      this.accumulatorMs -= this.tickMs;
      processed += 1;
    }

    // A backgrounded tab should rebuild from the next authoritative snapshot,
    // rather than fast-forwarding several hundred ticks when it returns.
    if (this.accumulatorMs >= this.tickMs) this.accumulatorMs = 0;
  }

  /** Samples one fractional local tick ahead for smooth rendering. */
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
    this.headByTick.clear();
    this.recordCurrentHead();
  }

  private recordCurrentHead(): void {
    const current = this.current;
    const head = current?.body[0];
    if (!current || !head) return;
    this.headByTick.set(current.tick, { x: head.x, y: head.y });
    const minimumTick = current.tick - POSITION_HISTORY_TICKS;
    for (const tick of this.headByTick.keys()) {
      if (tick >= minimumTick) break;
      this.headByTick.delete(tick);
    }
  }

  private projectHead(snapshotTick: number): MotionPoint | undefined {
    const current = this.current;
    if (!current) return undefined;
    const leadTicks = snapshotTick - current.tick;
    if (leadTicks <= 0 || leadTicks > MAX_AUTHORITY_LEAD_TICKS) return undefined;

    const projected = cloneStep(current, current.tick);
    for (let tick = current.tick + 1; tick <= snapshotTick; tick += 1) {
      applyIntent(projected, this.latestIntent);
      advanceSnakeMotion(projected, this.rules, this.tickMs / 1000);
      projected.tick = tick;
    }
    const head = projected.body[0];
    return head ? { x: head.x, y: head.y } : undefined;
  }

  private translatePrediction(correction: SelfPositionCorrection, fromTick: number): void {
    const current = this.current;
    if (!current) return;
    for (const point of current.body) {
      point.x += correction.x;
      point.y += correction.y;
    }
    for (const [tick, head] of this.headByTick) {
      if (tick < fromTick) continue;
      head.x += correction.x;
      head.y += correction.y;
    }
  }
}

function meaningfulCorrection(
  correction: SelfPositionCorrection | undefined,
): SelfPositionCorrection | undefined {
  if (!correction) return undefined;
  return correction.x * correction.x + correction.y * correction.y > MINIMUM_CORRECTION_SQUARED
    ? correction
    : undefined;
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
