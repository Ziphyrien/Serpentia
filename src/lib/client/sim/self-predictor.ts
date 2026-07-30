import type { ClientGameRules, SnakeSnapshot } from "$lib/protocol";
import {
  advanceSnakeMotion,
  advanceSnakeSourceFrame,
  applySnakeBoostInput,
  bodyPointCount,
  normalizeAngle,
  normalizeSnakeDirectionDelta,
  quantizeSnakeTargetAngle,
  resizeBody,
  nextSnakeBodyScale,
  snakeMotionRules,
  type MotionPoint,
  type SnakeMotionRules,
  type SnakeMotionState,
} from "../../game/snake-motion";

/** 快照不携带加速计数余数，重基线时从 0 起算；长度仍由权威快照校正。 */
const REBASED_BOOST_FRAMES = 0;

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
  /**
   * Deterministic heading interpolated across the tick fraction.
   *
   * Must stay derived from the simulated angle: the head sprite has to point
   * along the path the body actually took, or it detaches from the neck on a
   * sharp turn. Remote snakes interpolate their authoritative angle the same way.
   */
  readonly angle: number;
  /** 当前离散身体缩放档位；渲染层不得再按长度连续插值。 */
  readonly bodyScale: number;
  readonly boosting: boolean;
  /** 当前本机画面对应的绝对 60 Hz 源帧，可含 tick 内小数。 */
  readonly presentationSourceFrame: number;
  /** 平滑画面当前应检验的下一个离散 60 Hz 源帧。 */
  readonly collisionSourceFrame: number;
  /** 由共享源帧运动函数算出的离散蛇头，不受 Hermite 显示插值过冲影响。 */
  readonly collisionHead: MotionPoint;
}

const MAX_FRAME_CATCH_UP_TICKS = 8;
const MAX_REPLAY_TICKS = 64;
const DEFAULT_PREDICTION_LEAD_TICKS = 2;
const POSITION_MATCH_TOLERANCE = 0.5;
const ANGLE_MATCH_TOLERANCE = 0.001;
const LENGTH_MATCH_TOLERANCE = 0.001;
/** 用约 11 个 60Hz 渲染帧消化进食引起的预测位置差，避免蛇头单帧跳到权威未来。 */
const PRESENTATION_CORRECTION_DURATION_MS = 180;
const PRESENTATION_CORRECTION_EPSILON = 0.001;

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
  private configuredLeadTicks = DEFAULT_PREDICTION_LEAD_TICKS;
  private activeLeadTicks = DEFAULT_PREDICTION_LEAD_TICKS;
  private lastServerTick = 0;
  private lastConfirmedSequence = -1;
  /** 服务端最近确认的聚合加速按住状态；实际 boosting 可能因长度不足而为 false。 */
  private confirmedBoostInputHeld = false;
  private presentationCorrectionX = 0;
  private presentationCorrectionY = 0;
  private presentationCorrectionRemainingMs = 0;
  private readonly inputsBySequence = new Map<number, ScheduledInput>();
  private readonly statesByTick = new Map<number, PredictedStep>();

  private readonly motion: SnakeMotionRules;

  constructor(rules: ClientGameRules, tickRate: number) {
    this.tickMs = 1000 / tickRate;
    this.motion = snakeMotionRules({
      tickRate,
      minimumLength: rules.minimumLength,
      maximumLength: rules.maximumLength,
    });
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
    advanceSnakeMotion(next, this.motion);
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
    const increasedLead = Math.max(0, this.configuredLeadTicks - this.activeLeadTicks);
    return baseTick + increasedLead + (this.accumulatorMs > 0 ? 2 : 1);
  }

  /** Applies measured lead to future inputs without shifting the visible simulation. */
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
    const preserveFoodBoostPresentation =
      predictedAtSnapshot !== undefined &&
      snapshot.length > predictedAtSnapshot.length + LENGTH_MATCH_TOLERANCE &&
      snapshot.boosting !== predictedAtSnapshot.boosting;
    const visibleBeforeRebase = preserveFoodBoostPresentation ? this.renderState() : undefined;
    if (!preserveFoodBoostPresentation) this.clearPresentationCorrection();
    this.confirmInputs(snapshot.lastInputSequence);
    this.current = fromSnapshot(
      snapshot,
      snapshotTick,
      this.confirmedBoostInputHeld || snapshot.boosting,
    );
    this.statesByTick.clear();
    this.recordCurrent();
    for (let tick = snapshotTick + 1; tick <= horizonTick; tick += 1) {
      this.simulateTick(tick);
    }
    this.accumulatorMs = previousAccumulator;
    this.lastLocalTime = previousLocalTime;
    if (visibleBeforeRebase !== undefined) {
      this.preservePresentationAfterReplay(visibleBeforeRebase);
    }
    this.lastServerTick = Math.max(this.lastServerTick, snapshotTick);
    this.pruneHistory(this.current.tick - MAX_REPLAY_TICKS);
  }

  reset(): void {
    this.current = undefined;
    this.accumulatorMs = 0;
    this.lastLocalTime = undefined;
    this.alive = false;
    this.activeLeadTicks = this.configuredLeadTicks;
    this.lastServerTick = 0;
    this.lastConfirmedSequence = -1;
    this.confirmedBoostInputHeld = false;
    this.clearPresentationCorrection();
    this.inputsBySequence.clear();
    this.statesByTick.clear();
  }

  /**
   * Advances simulation time only.
   *
   * Steering intent deliberately does not enter here. It reaches the simulation
   * through {@link scheduleInput}, which keeps the rendered heading tied to the
   * path the body actually takes.
   */
  advance(localNow: number): void {
    if (!this.alive || !this.current) {
      this.lastLocalTime = localNow;
      return;
    }

    if (this.lastLocalTime === undefined) this.lastLocalTime = localNow;
    const elapsed = Math.min(250, Math.max(0, localNow - this.lastLocalTime));
    this.lastLocalTime = localNow;
    this.decayPresentationCorrection(elapsed);
    this.accumulatorMs += elapsed;

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
    advanceSnakeMotion(next, this.motion);
    const ratio = Math.min(1, Math.max(0, this.accumulatorMs / this.tickMs));
    const collisionFrameOffset = Math.ceil(
      ratio * this.motion.sourceFramesPerTick - Number.EPSILON,
    );
    const collisionState = cloneStep(current, current.tick + 1);
    this.applyScheduledInput(collisionState.tick, collisionState);
    for (let frame = 0; frame < collisionFrameOffset; frame += 1) {
      advanceSnakeSourceFrame(collisionState, this.motion);
    }
    const collisionHead = collisionState.body[0];
    if (collisionHead === undefined) return undefined;
    const body = interpolateBodyContinuously(previous?.body, current.body, next.body, ratio);
    for (const point of body) {
      point.x += this.presentationCorrectionX;
      point.y += this.presentationCorrectionY;
    }
    return {
      body,
      angle: normalizeAngle(
        current.angle + normalizeSnakeDirectionDelta(next.angle - current.angle) * ratio,
      ),
      bodyScale: current.bodyScale,
      boosting: next.boosting,
      presentationSourceFrame: (current.tick + ratio) * this.motion.sourceFramesPerTick,
      collisionSourceFrame: current.tick * this.motion.sourceFramesPerTick + collisionFrameOffset,
      collisionHead: { ...collisionHead },
    };
  }

  private initialize(snapshot: SnakeSnapshot, snapshotTick: number, localNow: number): void {
    this.current = fromSnapshot(
      snapshot,
      snapshotTick,
      this.confirmedBoostInputHeld || snapshot.boosting,
    );
    this.accumulatorMs = 0;
    this.lastLocalTime = localNow;
    this.lastServerTick = snapshotTick;
    this.activeLeadTicks = this.configuredLeadTicks;
    this.alive = true;
    this.clearPresentationCorrection();
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
    advanceSnakeMotion(current, this.motion);
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
    state.targetAngle = quantizeSnakeTargetAngle(selected.angle);
    applySnakeBoostInput(state, selected.boosting, this.motion.minimumLength);
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
    const lengthChanged = Math.abs(lengthDelta) > LENGTH_MATCH_TOLERANCE;
    const states = [...this.statesByTick.entries()]
      .filter(([tick]) => tick >= snapshotTick)
      .sort(([left], [right]) => left - right);
    const heldBoostStopsInFuture = states.some(
      ([tick, state]) => tick > snapshotTick && !state.boosting && state.boostInputHeld,
    );
    const boostInputChangesInFuture = states.some(
      ([tick, state]) =>
        tick > snapshotTick && state.boostInputHeld !== predictedAtSnapshot.boostInputHeld,
    );
    const requiresMotionReplay =
      lengthChanged &&
      (boostInputChangesInFuture ||
        (predictedAtSnapshot.boosting && (lengthDelta < 0 || heldBoostStopsInFuture)));
    if (requiresMotionReplay) {
      // 长度会改变未来是否触底减速；不能只平移 length，必须从该权威 tick 重放运动。
      const visibleBeforeReplay = this.renderState();
      const horizonTick = this.current?.tick;
      if (horizonTick === undefined) return;

      this.current = cloneStep(predictedAtSnapshot, snapshotTick);
      this.current.length = snapshot.length;
      this.current.bodyScale = snapshot.bodyScale;
      resizeBody(this.current.body, bodyPointCount(this.current.length, this.motion));
      for (const tick of this.statesByTick.keys()) {
        if (tick > snapshotTick) this.statesByTick.delete(tick);
      }
      this.recordCurrent();
      for (let tick = snapshotTick + 1; tick <= horizonTick; tick += 1) {
        this.simulateTick(tick);
      }
      if (visibleBeforeReplay !== undefined) {
        this.preservePresentationAfterReplay(visibleBeforeReplay);
      }
      return;
    }

    for (const [tick, state] of states) {
      if (lengthChanged) {
        state.length =
          tick === snapshotTick ? snapshot.length : Math.max(0, state.length + lengthDelta);
        resizeBody(state.body, bodyPointCount(state.length, this.motion));
      }
      if (tick === snapshotTick) {
        state.bodyScale = snapshot.bodyScale;
        continue;
      }
      const previous = this.statesByTick.get(tick - 1);
      if (previous !== undefined) {
        // 每个目标值在一个 tick 的三个源帧中相同；第一次检查后重复检查不会再改变档位。
        state.bodyScale = nextSnakeBodyScale(
          previous.bodyScale,
          state.length,
          this.motion.minimumLength,
        );
      }
    }

    const current = this.current;
    if (current === undefined) return;
    const authoritativeCurrent = this.statesByTick.get(current.tick);
    if (authoritativeCurrent === undefined) return;
    current.length = authoritativeCurrent.length;
    current.bodyScale = authoritativeCurrent.bodyScale;
    resizeBody(current.body, bodyPointCount(current.length, this.motion));
  }

  private preservePresentationAfterReplay(previous: SelfRenderState): void {
    const current = this.renderState();
    const previousHead = previous.body[0];
    const currentHead = current?.body[0];
    if (previousHead === undefined || currentHead === undefined) return;
    const correctionX = previousHead.x - currentHead.x;
    const correctionY = previousHead.y - currentHead.y;
    if (Math.hypot(correctionX, correctionY) <= PRESENTATION_CORRECTION_EPSILON) return;
    this.presentationCorrectionX += correctionX;
    this.presentationCorrectionY += correctionY;
    this.presentationCorrectionRemainingMs = PRESENTATION_CORRECTION_DURATION_MS;
  }

  private decayPresentationCorrection(elapsedMs: number): void {
    const previousRemaining = this.presentationCorrectionRemainingMs;
    if (previousRemaining <= 0 || elapsedMs <= 0) return;
    const remaining = Math.max(0, previousRemaining - elapsedMs);
    const ratio = remaining / previousRemaining;
    this.presentationCorrectionX *= ratio;
    this.presentationCorrectionY *= ratio;
    this.presentationCorrectionRemainingMs = remaining;
    if (remaining === 0) this.clearPresentationCorrection();
  }

  private clearPresentationCorrection(): void {
    this.presentationCorrectionX = 0;
    this.presentationCorrectionY = 0;
    this.presentationCorrectionRemainingMs = 0;
  }

  private confirmInputs(sequence: number): void {
    let latest: ScheduledInput | undefined;
    for (const input of this.inputsBySequence.values()) {
      if (input.sequence <= this.lastConfirmedSequence || input.sequence > sequence) continue;
      if (latest === undefined || input.sequence > latest.sequence) latest = input;
    }
    if (latest !== undefined) this.confirmedBoostInputHeld = latest.boosting;

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

function fromSnapshot(
  snapshot: SnakeSnapshot,
  tick: number,
  boostInputHeld: boolean,
): PredictedStep {
  return {
    body: snapshot.body.map((point) => ({ x: point.x, y: point.y })),
    angle: quantizeSnakeTargetAngle(snapshot.angle),
    targetAngle: quantizeSnakeTargetAngle(snapshot.targetAngle ?? snapshot.angle),
    length: snapshot.length,
    bodyScale: snapshot.bodyScale,
    boosting: snapshot.boosting,
    boostInputHeld,
    boostFrames: REBASED_BOOST_FRAMES,
    tick,
  };
}

function cloneStep(state: PredictedStep, tick: number): PredictedStep {
  return {
    body: state.body.map((point) => ({ ...point })),
    angle: state.angle,
    targetAngle: state.targetAngle,
    length: state.length,
    bodyScale: state.bodyScale,
    boosting: state.boosting,
    boostInputHeld: state.boostInputHeld,
    boostFrames: state.boostFrames,
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
