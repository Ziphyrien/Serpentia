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

    const predictedAtSnapshot = this.headByTick.get(snapshotTick);
    let correction: SelfPositionCorrection | undefined;

    if (predictedAtSnapshot) {
      correction = {
        x: snapshotHead.x - predictedAtSnapshot.x,
        y: snapshotHead.y - predictedAtSnapshot.y,
      };
      this.translatePrediction(correction, snapshotTick);
      this.headByTick.set(snapshotTick, { x: snapshotHead.x, y: snapshotHead.y });
    } else {
      // A suspended tab or a long snapshot gap can move the authoritative tick
      // outside retained history. Rebuild position/body, but preserve an active
      // local steering angle so recovery does not jerk the head backwards.
      const oldHead = current.body[0];
      const localAngle = current.angle;
      const localTargetAngle = current.targetAngle;
      this.initialize(snapshot, snapshotTick, localNow);
      if (this.latestIntent.angle !== undefined && this.current) {
        this.current.angle = localAngle;
        this.current.targetAngle = localTargetAngle;
      }
      correction = oldHead
        ? { x: snapshotHead.x - oldHead.x, y: snapshotHead.y - oldHead.y }
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
