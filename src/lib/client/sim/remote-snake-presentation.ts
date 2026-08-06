import type { ClientGameRules, Point, SnakeSnapshot } from "$lib/protocol";
import {
  SNAKE_MOTION,
  advanceSnakeSourceFrame,
  normalizeAngle,
  normalizeSnakeDirectionDelta,
  quantizeSnakeTargetAngle,
  snakeMotionRules,
  type SnakeMotionRules,
  type SnakeMotionState,
} from "$lib/game/snake-motion";

export interface PresentedRemoteSnake {
  readonly id: string;
  readonly nickname: string;
  readonly skinId: number;
  readonly body: ReadonlyArray<Point>;
  readonly angle: number;
  readonly bodyScale: number;
  readonly length: number;
  readonly boosting: boolean;
  readonly alive: boolean;
  readonly invulnerable: boolean;
  readonly magnetUntilSourceFrame: number | null;
}

interface TrackedRemoteSnake {
  readonly skinId: number;
  readonly body: ReadonlyArray<Point>;
  readonly angle: number;
  readonly presentationSourceFrame: number;
  readonly authoritativeTick: number;
  readonly motionState: SnakeMotionState;
  readonly fractionalMotionState: SnakeMotionState | undefined;
  readonly fractionalSimulatedSourceFrame: number | undefined;
  readonly bodyCorrectionActive: boolean;
  readonly simulatedSourceFrame: number;
}

interface PredictedRemoteSnake {
  readonly view: PresentedRemoteSnake;
  readonly motionState: SnakeMotionState;
  readonly fractionalMotionState: SnakeMotionState | undefined;
  readonly fractionalSimulatedSourceFrame: number | undefined;
  readonly simulatedSourceFrame: number;
}

const MAX_PRESENTATION_ELAPSED_SECONDS = 0.1;
const CORRECTION_RATE_MULTIPLIER = 2;

export class RemoteSnakePresentation {
  private readonly motion: SnakeMotionRules;
  private readonly tracked = new Map<string, TrackedRemoteSnake>();

  constructor(rules: ClientGameRules, tickRate: number) {
    this.motion = snakeMotionRules({
      tickRate,
      minimumLength: rules.minimumLength,
      maximumLength: rules.maximumLength,
    });
  }

  sample(
    snakes: ReadonlyArray<SnakeSnapshot>,
    authoritativeTick: number,
    presentationSourceFrame: number,
    deltaMs: number,
    selfId: string | undefined,
  ): Array<PresentedRemoteSnake> {
    const elapsedSeconds = Math.min(MAX_PRESENTATION_ELAPSED_SECONDS, Math.max(0, deltaMs / 1_000));
    const seen = new Set<string>();
    const presented: Array<PresentedRemoteSnake> = [];

    for (const snake of snakes) {
      if (snake.id === selfId || !snake.alive || snake.body.length === 0) continue;
      seen.add(snake.id);
      const previous = this.tracked.get(snake.id);
      const prediction = predictRemoteSnake(
        snake,
        authoritativeTick,
        presentationSourceFrame,
        this.motion,
        previous,
      );
      const predicted = prediction.view;
      const canSmooth =
        previous !== undefined &&
        previous.skinId === snake.skinId &&
        presentationSourceFrame >= previous.presentationSourceFrame;
      const correctionDistance = maximumCorrectionDistance(predicted.boosting, elapsedSeconds);
      const canSkipSmoothing =
        canSmooth &&
        !previous.bodyCorrectionActive &&
        previous.authoritativeTick === authoritativeTick &&
        correctionDistance >=
          maximumRegularTravelDistance(
            presentationSourceFrame - previous.presentationSourceFrame,
          );
      let body: ReadonlyArray<Point>;
      let bodyCorrectionActive: boolean;
      if (!canSmooth || canSkipSmoothing) {
        body = predicted.body;
        bodyCorrectionActive = false;
      } else {
        const smoothed = smoothBody(previous.body, predicted.body, correctionDistance);
        body = smoothed.body;
        bodyCorrectionActive = smoothed.correctionActive;
      }
      const angle = canSmooth
        ? smoothAngle(
            previous.angle,
            predicted.angle,
            this.motion.turnPerFrame *
              SNAKE_MOTION.sourceFrameRate *
              elapsedSeconds *
              CORRECTION_RATE_MULTIPLIER,
          )
        : predicted.angle;
      this.tracked.set(snake.id, {
        skinId: snake.skinId,
        body,
        angle,
        presentationSourceFrame,
        authoritativeTick,
        motionState: prediction.motionState,
        fractionalMotionState: prediction.fractionalMotionState,
        fractionalSimulatedSourceFrame: prediction.fractionalSimulatedSourceFrame,
        bodyCorrectionActive,
        simulatedSourceFrame: prediction.simulatedSourceFrame,
      });
      presented.push({ ...predicted, body, angle });
    }

    for (const id of this.tracked.keys()) {
      if (!seen.has(id)) this.tracked.delete(id);
    }
    return presented;
  }

  reset(): void {
    this.tracked.clear();
  }
}

function predictRemoteSnake(
  snake: SnakeSnapshot,
  authoritativeTick: number,
  presentationSourceFrame: number,
  motion: SnakeMotionRules,
  previous: TrackedRemoteSnake | undefined,
): PredictedRemoteSnake {
  const authoritativeSourceFrame = authoritativeTick * motion.sourceFramesPerTick;
  const targetSourceFrame = Math.max(authoritativeSourceFrame, presentationSourceFrame);
  const wholeTargetSourceFrame = Math.floor(targetSourceFrame);
  const canContinue =
    previous !== undefined &&
    previous.authoritativeTick === authoritativeTick &&
    previous.simulatedSourceFrame <= wholeTargetSourceFrame;
  const state = canContinue
    ? previous.motionState
    : motionStateFrom(snake, previous?.motionState);
  let simulatedSourceFrame = canContinue ? previous.simulatedSourceFrame : authoritativeSourceFrame;
  while (simulatedSourceFrame < wholeTargetSourceFrame) {
    advanceSnakeSourceFrame(state, motion);
    simulatedSourceFrame += 1;
  }

  const fraction = targetSourceFrame - wholeTargetSourceFrame;
  let body: ReadonlyArray<Point>;
  let angle = state.angle;
  let fractionalMotionState = previous?.fractionalMotionState;
  let fractionalSimulatedSourceFrame = previous?.fractionalSimulatedSourceFrame;
  if (fraction > 0) {
    const desiredFractionalSourceFrame = wholeTargetSourceFrame + 1;
    const reusable = previous?.fractionalMotionState;
    const reusableSourceFrame = previous?.fractionalSimulatedSourceFrame;
    let next: SnakeMotionState;
    let nextSourceFrame: number;
    if (
      canContinue &&
      reusable !== undefined &&
      reusableSourceFrame !== undefined &&
      reusableSourceFrame <= desiredFractionalSourceFrame
    ) {
      next = reusable;
      nextSourceFrame = reusableSourceFrame;
    } else {
      next = copyMotionState(state, reusable);
      nextSourceFrame = wholeTargetSourceFrame;
    }
    while (nextSourceFrame < desiredFractionalSourceFrame) {
      advanceSnakeSourceFrame(next, motion);
      nextSourceFrame += 1;
    }
    fractionalMotionState = next;
    fractionalSimulatedSourceFrame = nextSourceFrame;
    body = interpolateBody(state.body, next.body, fraction);
    angle = normalizeAngle(
      state.angle + normalizeSnakeDirectionDelta(next.angle - state.angle) * fraction,
    );
  } else {
    body = state.body.map((point) => ({ ...point }));
    if (!canContinue) {
      fractionalMotionState = undefined;
      fractionalSimulatedSourceFrame = undefined;
    }
  }

  return {
    view: {
      id: snake.id,
      nickname: snake.nickname,
      skinId: snake.skinId,
      body,
      angle,
      bodyScale: state.bodyScale,
      length: state.length,
      boosting: state.boosting,
      alive: snake.alive,
      invulnerable: snake.invulnerable,
      magnetUntilSourceFrame: snake.magnetUntilSourceFrame ?? null,
    },
    motionState: state,
    fractionalMotionState,
    fractionalSimulatedSourceFrame,
    simulatedSourceFrame,
  };
}

function motionStateFrom(
  snake: SnakeSnapshot,
  reusable: SnakeMotionState | undefined,
): SnakeMotionState {
  const target = reusable ?? {
    body: [],
    angle: 0,
    targetAngle: 0,
    length: snake.length,
    bodyScale: snake.bodyScale,
    boosting: snake.boosting,
    boostInputHeld: snake.boosting,
    boostFrames: 0,
  };
  target.angle = quantizeSnakeTargetAngle(snake.angle);
  target.targetAngle = quantizeSnakeTargetAngle(snake.targetAngle ?? snake.angle);
  target.length = snake.length;
  target.bodyScale = snake.bodyScale;
  target.boosting = snake.boosting;
  target.boostInputHeld = snake.boosting;
  target.boostFrames = 0;
  target.body.length = snake.body.length;
  for (let index = 0; index < snake.body.length; index += 1) {
    const source = snake.body[index];
    const point = target.body[index];
    if (source === undefined) continue;
    if (point === undefined) {
      target.body[index] = { x: source.x, y: source.y };
    } else {
      point.x = source.x;
      point.y = source.y;
    }
  }
  return target;
}

function copyMotionState(
  state: SnakeMotionState,
  reusable: SnakeMotionState | undefined,
): SnakeMotionState {
  const target = reusable ?? {
    body: [],
    angle: state.angle,
    targetAngle: state.targetAngle,
    length: state.length,
    bodyScale: state.bodyScale,
    boosting: state.boosting,
    boostInputHeld: state.boostInputHeld,
    boostFrames: state.boostFrames,
  };
  target.angle = state.angle;
  target.targetAngle = state.targetAngle;
  target.length = state.length;
  target.bodyScale = state.bodyScale;
  target.boosting = state.boosting;
  target.boostInputHeld = state.boostInputHeld;
  target.boostFrames = state.boostFrames;
  target.body.length = state.body.length;
  for (let index = 0; index < state.body.length; index += 1) {
    const source = state.body[index];
    const point = target.body[index];
    if (source === undefined) continue;
    if (point === undefined) {
      target.body[index] = { x: source.x, y: source.y };
    } else {
      point.x = source.x;
      point.y = source.y;
    }
  }
  return target;
}

function interpolateBody(
  from: ReadonlyArray<Point>,
  to: ReadonlyArray<Point>,
  ratio: number,
): Array<Point> {
  if (from.length === to.length) {
    const body = new Array<Point>(from.length);
    for (let index = 0; index < from.length; index += 1) {
      const start = from[index];
      const end = to[index];
      if (start === undefined || end === undefined) continue;
      body[index] = {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      };
    }
    return body;
  }

  const pointCount = Math.max(from.length, to.length);
  const body = new Array<Point>(pointCount);
  const fromLast = from[from.length - 1];
  const toLast = to[to.length - 1];
  for (let index = 0; index < pointCount; index += 1) {
    const start = index < from.length ? from[index] : fromLast;
    const end = index < to.length ? to[index] : toLast;
    if (start === undefined || end === undefined) continue;
    body[index] = {
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
    };
  }
  return body;
}

interface SmoothedBody {
  readonly body: Array<Point>;
  readonly correctionActive: boolean;
}

function smoothBody(
  from: ReadonlyArray<Point>,
  to: ReadonlyArray<Point>,
  maximumDistance: number,
): SmoothedBody {
  const maximumDistanceSquared = maximumDistance * maximumDistance;
  let correctionActive = false;
  const body = to.map((point, index) => {
    const fromPoint = from[Math.min(index, from.length - 1)] ?? point;
    const deltaX = point.x - fromPoint.x;
    const deltaY = point.y - fromPoint.y;
    const distanceSquared = deltaX * deltaX + deltaY * deltaY;
    if (distanceSquared === 0 || distanceSquared <= maximumDistanceSquared) {
      return { ...point };
    }
    correctionActive = true;
    if (maximumDistance <= 0) return { ...fromPoint };
    const ratio = maximumDistance / Math.sqrt(distanceSquared);
    return { x: fromPoint.x + deltaX * ratio, y: fromPoint.y + deltaY * ratio };
  });
  return { body, correctionActive };
}

function smoothAngle(from: number, to: number, maximumTurn: number): number {
  const difference = normalizeSnakeDirectionDelta(to - from);
  if (Math.abs(difference) <= maximumTurn) return to;
  return normalizeAngle(from + Math.sign(difference) * maximumTurn);
}

function maximumRegularTravelDistance(sourceFrameDelta: number): number {
  return (
    Math.max(0, sourceFrameDelta) *
    SNAKE_MOTION.boostPointsPerFrame *
    SNAKE_MOTION.pointSpacing
  );
}

function maximumCorrectionDistance(boosting: boolean, elapsedSeconds: number): number {
  const pointsPerFrame = boosting ? SNAKE_MOTION.boostPointsPerFrame : SNAKE_MOTION.pointsPerFrame;
  return (
    pointsPerFrame *
    SNAKE_MOTION.pointSpacing *
    SNAKE_MOTION.sourceFrameRate *
    elapsedSeconds *
    CORRECTION_RATE_MULTIPLIER
  );
}
