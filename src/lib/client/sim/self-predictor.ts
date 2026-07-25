import type { ClientGameRules, SnakeSnapshot } from "$lib/protocol";
import {
  advanceSnakeMotion,
  normalizeAngle,
  trimBody,
  turnTowards,
  type MotionPoint,
  type SnakeMotionState,
} from "../../game/snake-motion";

export interface ScheduledInput {
  readonly sequence: number;
  readonly targetTick: number;
  readonly angle: number;
  readonly boosting: boolean;
}

interface PredictedStep extends SnakeMotionState {
  tick: number;
}

export interface SelfRenderState {
  /** C¹ presentation path through deterministic tick positions; tick endpoints remain exact. */
  readonly body: ReadonlyArray<MotionPoint>;
  /** Immediate visual heading; movement uses the scheduled authoritative input. */
  readonly angle: number;
  readonly boosting: boolean;
  readonly collisionTick: number;
  readonly collisionHead: MotionPoint;
}

const MAX_FRAME_CATCH_UP_TICKS = 8;
const MAX_REPLAY_TICKS = 64;
const DEFAULT_PREDICTION_LEAD_TICKS = 2;
const POSITION_MATCH_TOLERANCE = 0.5;
const ANGLE_MATCH_TOLERANCE = 0.001;

/**
 * Deterministic local prediction with a small future-tick lead.
 *
 * Inputs are scheduled on an authoritative tick instead of being applied when
 * the WebSocket callback happens. Snapshots validate one historical state and
 * only rebuild the predicted future when that state actually diverges. This
 * keeps normal 10 Hz snapshot quantization out of the visible head trajectory.
 */
export class SelfPredictor {
  private current: PredictedStep | undefined;
  private readonly tickMs: number;
  private accumulatorMs = 0;
  private lastLocalTime: number | undefined;
  private alive = false;
  private visualAngle = 0;
  private configuredLeadTicks = DEFAULT_PREDICTION_LEAD_TICKS;
  private activeLeadTicks = DEFAULT_PREDICTION_LEAD_TICKS;
  private lastServerTick = 0;
  private lastConfirmedSequence = -1;
  private readonly inputsBySequence = new Map<number, ScheduledInput>();
  private readonly statesByTick = new Map<number, PredictedStep>();

  constructor(
    private readonly rules: ClientGameRules,
    tickRate: number,
  ) {
    this.tickMs = 1000 / tickRate;
  }

  get currentLength(): number {
    return this.current?.length ?? 0;
  }

  headAtTick(tick: number): MotionPoint | undefined {
    const recorded = this.statesByTick.get(tick)?.body[0];
    if (recorded !== undefined) return { ...recorded };
    const current = this.current;
    if (current === undefined || tick !== current.tick + 1) return undefined;
    const next = cloneStep(current, tick);
    this.applyScheduledInput(tick, next);
    advanceSnakeMotion(next, this.rules, this.tickMs / 1000);
    const head = next.body[0];
    return head === undefined ? undefined : { ...head };
  }

  /**
   * Returns the next simulation tick whose render segment has not started.
   *
   * Once a fractional segment is visible, rewriting its end state moves the
   * interpolated head immediately. Reserve that segment and schedule later
   * input on the following tick instead.
   */
  get nextInputTick(): number {
    const baseTick = this.current?.tick ?? this.lastServerTick + this.activeLeadTicks;
    return baseTick + (this.accumulatorMs > 0 ? 2 : 1);
  }

  /** Updates the lead used by the next spawn/reconnect phase. */
  setPredictionLeadTicks(value: number): void {
    this.configuredLeadTicks = Math.min(3, Math.max(2, Math.floor(value)));
  }

  scheduleInput(input: ScheduledInput): void {
    const previous = this.inputsBySequence.get(input.sequence);
    if (previous !== undefined && previous.targetTick > input.targetTick) return;
    this.inputsBySequence.set(input.sequence, input);
  }

  /** Remaps a late input after the server reports the tick where it really ran. */
  acknowledgeInput(sequence: number, targetTick: number, appliedTick: number): void {
    const input = this.inputsBySequence.get(sequence);
    if (input === undefined || input.targetTick !== targetTick) return;
    this.remapFromAuthority(sequence, appliedTick);
  }

  reconcile(snapshot: SnakeSnapshot, snapshotTick: number, localNow: number): void {
    if (!snapshot.alive || snapshot.body.length === 0) {
      this.reset();
      return;
    }

    // A snapshot also recovers an ack lost during reconnect or backpressure.
    this.remapFromAuthority(snapshot.lastInputSequence, snapshot.lastInputAppliedTick);
    const previous = this.current;
    const predictedAtSnapshot = this.statesByTick.get(snapshotTick);
    if (previous === undefined) {
      this.confirmInputs(snapshot.lastInputSequence);
      this.initialize(snapshot, snapshotTick, localNow);
      return;
    }

    if (predictedAtSnapshot !== undefined && sameAuthoritativePose(predictedAtSnapshot, snapshot)) {
      this.applyAuthoritativeMetadata(snapshot, snapshotTick, predictedAtSnapshot);
      this.confirmInputs(snapshot.lastInputSequence);
      this.lastServerTick = Math.max(this.lastServerTick, snapshotTick);
      this.pruneHistory(previous.tick - MAX_REPLAY_TICKS);
      return;
    }

    const horizonTick = Math.max(previous.tick, snapshotTick + this.activeLeadTicks);
    if (horizonTick - snapshotTick > MAX_REPLAY_TICKS) {
      this.confirmInputs(snapshot.lastInputSequence);
      this.initialize(snapshot, snapshotTick, localNow);
      return;
    }

    const previousAccumulator = this.accumulatorMs;
    const previousLocalTime = this.lastLocalTime;
    this.current = fromSnapshot(snapshot, snapshotTick);
    this.statesByTick.clear();
    this.recordCurrent();
    this.confirmInputs(snapshot.lastInputSequence);
    for (let tick = snapshotTick + 1; tick <= horizonTick; tick += 1) {
      this.simulateTick(tick);
    }
    this.accumulatorMs = previousAccumulator;
    this.lastLocalTime = previousLocalTime;
    this.lastServerTick = Math.max(this.lastServerTick, snapshotTick);
    this.pruneHistory(this.current.tick - MAX_REPLAY_TICKS);
  }

  reset(): void {
    this.current = undefined;
    this.accumulatorMs = 0;
    this.lastLocalTime = undefined;
    this.visualAngle = 0;
    this.alive = false;
    this.activeLeadTicks = this.configuredLeadTicks;
    this.lastServerTick = 0;
    this.lastConfirmedSequence = -1;
    this.inputsBySequence.clear();
    this.statesByTick.clear();
  }

  advance(localNow: number, intentAngle: number | undefined, _intentBoosting: boolean): void {
    if (!this.alive || !this.current) {
      this.lastLocalTime = localNow;
      return;
    }

    if (this.lastLocalTime === undefined) this.lastLocalTime = localNow;
    const elapsed = Math.min(250, Math.max(0, localNow - this.lastLocalTime));
    this.lastLocalTime = localNow;
    this.accumulatorMs += elapsed;

    if (intentAngle === undefined) {
      this.visualAngle = turnTowards(
        this.visualAngle,
        this.current.targetAngle,
        this.rules.turnRate * (elapsed / 1000),
      );
    } else {
      this.visualAngle = intentAngle;
    }

    let processed = 0;
    while (this.accumulatorMs >= this.tickMs && processed < MAX_FRAME_CATCH_UP_TICKS) {
      this.simulateTick(this.current.tick + 1);
      this.accumulatorMs -= this.tickMs;
      processed += 1;
    }

    if (this.accumulatorMs >= this.tickMs) this.accumulatorMs = 0;
    this.pruneHistory(this.current.tick - MAX_REPLAY_TICKS);
  }

  renderState(): SelfRenderState | undefined {
    const current = this.current;
    if (!current) return undefined;

    const previous = this.statesByTick.get(current.tick - 1);
    const next = cloneStep(current, current.tick + 1);
    this.applyScheduledInput(next.tick, next);
    advanceSnakeMotion(next, this.rules, this.tickMs / 1000);
    const ratio = Math.min(1, Math.max(0, this.accumulatorMs / this.tickMs));
    const collisionState = ratio > 0 ? next : current;
    const collisionHead = collisionState.body[0];
    if (collisionHead === undefined) return undefined;
    return {
      body: interpolateBodyContinuously(previous?.body, current.body, next.body, ratio),
      angle: this.visualAngle,
      boosting: next.boosting,
      collisionTick: collisionState.tick,
      collisionHead: { ...collisionHead },
    };
  }

  private initialize(snapshot: SnakeSnapshot, snapshotTick: number, localNow: number): void {
    this.current = fromSnapshot(snapshot, snapshotTick);
    this.accumulatorMs = 0;
    this.lastLocalTime = localNow;
    this.lastServerTick = snapshotTick;
    this.activeLeadTicks = this.configuredLeadTicks;
    this.alive = true;
    this.visualAngle = snapshot.angle;
    this.statesByTick.clear();
    this.recordCurrent();

    for (let index = 0; index < this.activeLeadTicks; index += 1) {
      this.simulateTick(this.current.tick + 1);
    }
  }

  private simulateTick(tick: number): void {
    const current = this.current;
    if (!current) return;
    this.applyScheduledInput(tick, current);
    advanceSnakeMotion(current, this.rules, this.tickMs / 1000);
    current.tick = tick;
    this.recordCurrent();
  }

  private applyScheduledInput(tick: number, state: PredictedStep): void {
    let selected: ScheduledInput | undefined;
    for (const input of this.inputsBySequence.values()) {
      if (input.targetTick !== tick) continue;
      if (selected === undefined || input.sequence > selected.sequence) selected = input;
    }
    if (selected === undefined) return;
    state.targetAngle = selected.angle;
    state.boosting = selected.boosting;
  }

  private remapFromAuthority(sequence: number, appliedTick: number): void {
    const input = this.inputsBySequence.get(sequence);
    if (input === undefined || input.targetTick === appliedTick) return;
    const previousTick = input.targetTick;
    this.inputsBySequence.set(sequence, { ...input, targetTick: appliedTick });
    this.replayFromTick(Math.max(this.lastServerTick, Math.min(previousTick, appliedTick) - 1));
  }

  private replayFromTick(baseTick: number): void {
    const current = this.current;
    const base = this.statesByTick.get(baseTick);
    if (current === undefined || base === undefined || baseTick >= current.tick) return;

    const horizonTick = current.tick;
    this.current = cloneStep(base, base.tick);
    for (const tick of this.statesByTick.keys()) {
      if (tick > baseTick) this.statesByTick.delete(tick);
    }
    for (let tick = baseTick + 1; tick <= horizonTick; tick += 1) this.simulateTick(tick);
  }

  private applyAuthoritativeMetadata(
    snapshot: SnakeSnapshot,
    snapshotTick: number,
    predictedAtSnapshot: PredictedStep,
  ): void {
    const lengthDelta = snapshot.length - predictedAtSnapshot.length;
    if (Math.abs(lengthDelta) > 0.001) {
      for (const [tick, state] of this.statesByTick) {
        if (tick < snapshotTick) continue;
        state.length = Math.max(0, state.length + lengthDelta);
        trimBody(state.body, state.length);
      }
      if (this.current !== undefined) {
        this.current.length = Math.max(0, this.current.length + lengthDelta);
        trimBody(this.current.body, this.current.length);
      }
    }
  }

  private confirmInputs(sequence: number): void {
    this.lastConfirmedSequence = Math.max(this.lastConfirmedSequence, sequence);
    for (const candidate of this.inputsBySequence.keys()) {
      if (candidate <= this.lastConfirmedSequence) this.inputsBySequence.delete(candidate);
    }
  }

  private recordCurrent(): void {
    if (this.current === undefined) return;
    this.statesByTick.set(this.current.tick, cloneStep(this.current, this.current.tick));
  }

  private pruneHistory(minimumTick: number): void {
    for (const tick of this.statesByTick.keys()) {
      if (tick < minimumTick) this.statesByTick.delete(tick);
    }
  }
}

function sameAuthoritativePose(state: PredictedStep, snapshot: SnakeSnapshot): boolean {
  const predictedHead = state.body[0];
  const authoritativeHead = snapshot.body[0];
  if (predictedHead === undefined || authoritativeHead === undefined) return false;
  const authoritativeTarget = snapshot.targetAngle ?? snapshot.angle;
  return (
    Math.hypot(predictedHead.x - authoritativeHead.x, predictedHead.y - authoritativeHead.y) <=
      POSITION_MATCH_TOLERANCE &&
    Math.abs(normalizeAngle(state.angle - snapshot.angle)) <= ANGLE_MATCH_TOLERANCE &&
    Math.abs(normalizeAngle(state.targetAngle - authoritativeTarget)) <= ANGLE_MATCH_TOLERANCE &&
    state.boosting === snapshot.boosting
  );
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

/**
 * Uses each segment's incoming and outgoing deterministic velocity as Hermite
 * tangents. The curve passes through both tick positions and has a continuous
 * derivative across a normal tick boundary.
 */
function interpolateBodyContinuously(
  previous: ReadonlyArray<MotionPoint> | undefined,
  from: ReadonlyArray<MotionPoint>,
  to: ReadonlyArray<MotionPoint>,
  ratio: number,
): Array<MotionPoint> {
  const pointCount = Math.max(from.length, to.length);
  const body: Array<MotionPoint> = [];
  const h00 = 2 * ratio * ratio * ratio - 3 * ratio * ratio + 1;
  const h10 = ratio * ratio * ratio - 2 * ratio * ratio + ratio;
  const h01 = -2 * ratio * ratio * ratio + 3 * ratio * ratio;
  const h11 = ratio * ratio * ratio - ratio * ratio;

  for (let index = 0; index < pointCount; index += 1) {
    const before = previous?.[Math.min(index, previous.length - 1)];
    const current = from[Math.min(index, from.length - 1)];
    const next = to[Math.min(index, to.length - 1)];
    const outgoingX = next.x - current.x;
    const outgoingY = next.y - current.y;
    const previousX = before === undefined ? outgoingX : current.x - before.x;
    const previousY = before === undefined ? outgoingY : current.y - before.y;
    const previousLength = Math.hypot(previousX, previousY);
    const outgoingLength = Math.hypot(outgoingX, outgoingY);
    const tangentScale = previousLength === 0 ? 0 : outgoingLength / previousLength;
    // Preserve the current deterministic segment speed while rotating from
    // the preceding segment direction to this segment direction.
    const incomingX = previousLength === 0 ? outgoingX : previousX * tangentScale;
    const incomingY = previousLength === 0 ? outgoingY : previousY * tangentScale;
    body.push({
      x: h00 * current.x + h10 * incomingX + h01 * next.x + h11 * outgoingX,
      y: h00 * current.y + h10 * incomingY + h01 * next.y + h11 * outgoingY,
    });
  }
  return body;
}
