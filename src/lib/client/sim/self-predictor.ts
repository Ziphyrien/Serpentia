import type { ClientGameRules, SnakeSnapshot } from "$lib/protocol";
import {
  advanceSnakeMotion,
  normalizeAngle,
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

interface VisualCorrection {
  readonly body: ReadonlyArray<MotionPoint>;
  readonly angle: number;
  readonly startedAt: number;
}

const MAX_REPLAY_TICKS = 32;
const MAX_FRAME_CATCH_UP_TICKS = 8;
const CORRECTION_DURATION_MS = 120;

/**
 * Local prediction for the controlled snake.
 *
 * Every simulated server tick records the intent used for that tick. A snapshot
 * rewinds to its authoritative tick and replays those recorded intents to the
 * existing prediction horizon. Rendering keeps a short-lived error offset so a
 * correction changes the simulation immediately without moving the picture in
 * the same frame.
 */
export class SelfPredictor {
  private previous: PredictedStep | undefined;
  private current: PredictedStep | undefined;
  private nextTick = 0;
  private nextTickAt = 0;
  private readonly tickMs: number;
  private readonly intentByTick = new Map<number, InputIntent>();
  private latestIntent: InputIntent = { boosting: false };
  private correction: VisualCorrection | undefined;
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

  reconcile(
    snapshot: SnakeSnapshot,
    snapshotTick: number,
    snapshotServerTime: number,
    serverNow: number,
    intentAngle: number | undefined,
    intentBoosting: boolean,
  ): void {
    this.latestIntent = { angle: intentAngle, boosting: intentBoosting };
    if (!snapshot.alive) {
      this.reset();
      return;
    }

    const before = this.sampleVisual(serverNow);
    const authoritative = fromSnapshot(snapshot, snapshotTick);
    const oldCurrent = this.current;
    const oldPrevious = this.previous;
    const oldNextTickAt = this.nextTickAt;
    const canReplay =
      oldCurrent !== undefined &&
      oldPrevious !== undefined &&
      snapshotTick <= oldCurrent.tick &&
      oldCurrent.tick - snapshotTick <= MAX_REPLAY_TICKS;

    this.alive = true;
    if (canReplay) {
      const horizonTick = oldCurrent.tick;
      this.current = authoritative;
      this.previous =
        oldPrevious.tick === snapshotTick - 1
          ? oldPrevious
          : cloneStep(authoritative, snapshotTick - 1);

      for (let tick = snapshotTick + 1; tick <= horizonTick; tick += 1) {
        this.simulateTick(tick, this.intentByTick.get(tick));
      }
      this.nextTick = horizonTick + 1;
      this.nextTickAt = oldNextTickAt;
    } else {
      this.previous = cloneStep(authoritative, snapshotTick - 1);
      this.current = authoritative;
      this.nextTick = snapshotTick + 1;
      this.nextTickAt = snapshotServerTime + this.tickMs;
    }

    this.advanceTo(serverNow);
    this.pruneIntentHistory(snapshotTick);

    const after = this.sampleRaw(serverNow);
    if (before && after) this.startCorrection(before, after, serverNow);
    else this.correction = undefined;
  }

  /** Stops prediction until an alive authoritative snapshot initializes it again. */
  markDead(): void {
    this.reset();
  }

  /** Advances fixed simulation ticks using the latest local intent. */
  advance(serverNow: number, intentAngle: number | undefined, intentBoosting: boolean): void {
    this.latestIntent = { angle: intentAngle, boosting: intentBoosting };
    if (!this.alive || !this.current) return;
    this.advanceTo(serverNow);
  }

  /** Returns the interpolated pose, including short-lived reconciliation smoothing. */
  renderState(serverNow: number): SelfRenderState | undefined {
    return this.sampleVisual(serverNow);
  }

  private advanceTo(serverNow: number): void {
    let processed = 0;
    while (this.nextTickAt <= serverNow && processed < MAX_FRAME_CATCH_UP_TICKS) {
      const intent = this.intentByTick.get(this.nextTick) ?? this.latestIntent;
      this.intentByTick.set(this.nextTick, intent);
      this.simulateTick(this.nextTick, intent);
      this.nextTick += 1;
      this.nextTickAt += this.tickMs;
      processed += 1;
    }

    // A backgrounded tab may be many ticks behind. Keep the current frame stable;
    // the next authoritative snapshot will rebuild the missing timeline.
    if (this.nextTickAt <= serverNow) this.nextTickAt = serverNow + this.tickMs;
  }

  private simulateTick(tick: number, intent: InputIntent | undefined): void {
    const current = this.current;
    if (!current) return;

    const next = cloneStep(current, tick);
    if (intent?.angle !== undefined) next.targetAngle = intent.angle;
    if (intent) next.boosting = intent.boosting;
    advanceSnakeMotion(next, this.rules, this.tickMs / 1000);

    this.previous = current;
    this.current = next;
  }

  private sampleRaw(serverNow: number): SelfRenderState | undefined {
    if (!this.current || !this.previous) return undefined;
    const alpha = Math.min(1, Math.max(0, 1 - (this.nextTickAt - serverNow) / this.tickMs));
    return {
      body: interpolateBody(this.previous.body, this.current.body, alpha),
      angle: interpolateAngle(this.previous.angle, this.current.angle, alpha),
      boosting: this.current.boosting,
    };
  }

  private sampleVisual(serverNow: number): SelfRenderState | undefined {
    const raw = this.sampleRaw(serverNow);
    if (!raw) return undefined;
    const correction = this.correction;
    if (!correction) return raw;

    const progress = Math.min(
      1,
      Math.max(0, (serverNow - correction.startedAt) / CORRECTION_DURATION_MS),
    );
    if (progress >= 1) {
      this.correction = undefined;
      return raw;
    }

    const remaining = 1 - progress * progress * (3 - 2 * progress);
    const lastCorrection = correction.body[correction.body.length - 1] ?? { x: 0, y: 0 };
    return {
      body: raw.body.map((point, index) => {
        const delta = correction.body[index] ?? lastCorrection;
        return {
          x: point.x + delta.x * remaining,
          y: point.y + delta.y * remaining,
        };
      }),
      angle: normalizeAngle(raw.angle + correction.angle * remaining),
      boosting: raw.boosting,
    };
  }

  private startCorrection(
    before: SelfRenderState,
    after: SelfRenderState,
    serverNow: number,
  ): void {
    const beforeHead = before.body[0];
    const afterHead = after.body[0];
    if (!beforeHead || !afterHead) {
      this.correction = undefined;
      return;
    }

    const headError = Math.hypot(beforeHead.x - afterHead.x, beforeHead.y - afterHead.y);
    const snapDistance = this.rules.boostSpeed * 0.75;
    if (headError > snapDistance) {
      this.correction = undefined;
      return;
    }

    const pointCount = Math.max(before.body.length, after.body.length);
    const body: Array<MotionPoint> = [];
    let largestError = headError;
    for (let index = 0; index < pointCount; index += 1) {
      const oldPoint = before.body[Math.min(index, before.body.length - 1)];
      const newPoint = after.body[Math.min(index, after.body.length - 1)];
      let x = oldPoint.x - newPoint.x;
      let y = oldPoint.y - newPoint.y;
      const distance = Math.hypot(x, y);
      largestError = Math.max(largestError, distance);
      if (distance > snapDistance) {
        const scale = snapDistance / distance;
        x *= scale;
        y *= scale;
      }
      body.push({ x, y });
    }

    const angle = normalizeAngle(before.angle - after.angle);
    if (largestError < 0.001 && Math.abs(angle) < 0.0001) {
      this.correction = undefined;
      return;
    }
    this.correction = { body, angle, startedAt: serverNow };
  }

  private pruneIntentHistory(snapshotTick: number): void {
    for (const tick of this.intentByTick.keys()) {
      if (tick <= snapshotTick) this.intentByTick.delete(tick);
    }
  }

  private reset(): void {
    this.alive = false;
    this.previous = undefined;
    this.current = undefined;
    this.nextTick = 0;
    this.nextTickAt = 0;
    this.intentByTick.clear();
    this.correction = undefined;
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
  return normalizeAngle(from + normalizeAngle(to - from) * ratio);
}
