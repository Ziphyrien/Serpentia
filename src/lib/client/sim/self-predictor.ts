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
const BODY_CORRECTION_DURATION_MS = 100;
const ANGLE_CORRECTION_DURATION_MS = 35;

/**
 * Tick-based client prediction for the controlled snake.
 *
 * The simulation is rewound to the snapshot tick and replayed with the intent
 * that was used for each local tick. Rendering samples one fractional tick
 * forward from the latest completed state, so local turning does not inherit a
 * full server tick of input latency. Authoritative corrections are applied to
 * the simulation immediately and removed from the rendered pose smoothly.
 */
export class SelfPredictor {
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
    const oldNextTickAt = this.nextTickAt;
    const canReplay =
      oldCurrent !== undefined &&
      snapshotTick <= oldCurrent.tick &&
      oldCurrent.tick - snapshotTick <= MAX_REPLAY_TICKS;

    this.alive = true;
    if (canReplay) {
      const horizonTick = oldCurrent.tick;
      this.current = authoritative;
      for (let tick = snapshotTick + 1; tick <= horizonTick; tick += 1) {
        this.simulateTick(tick, this.intentByTick.get(tick));
      }
      this.nextTick = horizonTick + 1;
      this.nextTickAt = oldNextTickAt;
    } else {
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

  /** Returns a forward-sampled pose with a short-lived reconciliation correction. */
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

    // A backgrounded tab may be many ticks behind. The next snapshot will
    // rebuild the timeline instead of making the foreground frame fast-forward.
    if (this.nextTickAt <= serverNow) this.nextTickAt = serverNow + this.tickMs;
  }

  private simulateTick(tick: number, intent: InputIntent | undefined): void {
    const current = this.current;
    if (!current) return;

    const next = cloneStep(current, tick);
    applyIntent(next, intent);
    advanceSnakeMotion(next, this.rules, this.tickMs / 1000);
    this.current = next;
  }

  private sampleRaw(serverNow: number): SelfRenderState | undefined {
    const current = this.current;
    if (!current) return undefined;

    const alpha = Math.min(1, Math.max(0, 1 - (this.nextTickAt - serverNow) / this.tickMs));
    const next = cloneStep(current, this.nextTick);
    applyIntent(next, this.latestIntent);
    advanceSnakeMotion(next, this.rules, this.tickMs / 1000);
    return {
      body: interpolateBody(current.body, next.body, alpha),
      angle: interpolateAngle(current.angle, next.angle, alpha),
      boosting: next.boosting,
    };
  }

  private sampleVisual(serverNow: number): SelfRenderState | undefined {
    const raw = this.sampleRaw(serverNow);
    if (!raw) return undefined;
    const correction = this.correction;
    if (!correction) return raw;

    const bodyRemaining = decayRemaining(
      serverNow,
      correction.startedAt,
      BODY_CORRECTION_DURATION_MS,
    );
    const angleRemaining = decayRemaining(
      serverNow,
      correction.startedAt,
      ANGLE_CORRECTION_DURATION_MS,
    );
    if (bodyRemaining === 0 && angleRemaining === 0) {
      this.correction = undefined;
      return raw;
    }

    const body =
      bodyRemaining === 0
        ? raw.body
        : raw.body.map((point, index) => {
            const delta = correction.body[index] ?? correction.body[correction.body.length - 1];
            if (!delta) return point;
            return {
              x: point.x + delta.x * bodyRemaining,
              y: point.y + delta.y * bodyRemaining,
            };
          });
    return {
      body,
      angle: normalizeAngle(raw.angle + correction.angle * angleRemaining),
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

function applyIntent(state: PredictedStep, intent: InputIntent | undefined): void {
  if (!intent) return;
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
  return normalizeAngle(from + normalizeAngle(to - from) * ratio);
}

function decayRemaining(now: number, startedAt: number, duration: number): number {
  const progress = Math.min(1, Math.max(0, (now - startedAt) / duration));
  return 1 - progress * progress * (3 - 2 * progress);
}
