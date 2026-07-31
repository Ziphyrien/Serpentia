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
  readonly simulatedSourceFrame: number;
}

interface PredictedRemoteSnake {
  readonly view: PresentedRemoteSnake;
  readonly motionState: SnakeMotionState;
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
      const body = canSmooth
        ? smoothBody(
            previous.body,
            predicted.body,
            maximumCorrectionDistance(predicted.boosting, elapsedSeconds),
          )
        : predicted.body;
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
  const state = canContinue ? previous.motionState : motionStateFrom(snake);
  let simulatedSourceFrame = canContinue ? previous.simulatedSourceFrame : authoritativeSourceFrame;
  while (simulatedSourceFrame < wholeTargetSourceFrame) {
    advanceSnakeSourceFrame(state, motion);
    simulatedSourceFrame += 1;
  }

  const fraction = targetSourceFrame - wholeTargetSourceFrame;
  let body: ReadonlyArray<Point> = state.body.map((point) => ({ ...point }));
  let angle = state.angle;
  if (fraction > 0) {
    const next = cloneMotionState(state);
    advanceSnakeSourceFrame(next, motion);
    body = interpolateBody(state.body, next.body, fraction);
    angle = normalizeAngle(
      state.angle + normalizeSnakeDirectionDelta(next.angle - state.angle) * fraction,
    );
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
    simulatedSourceFrame,
  };
}

function motionStateFrom(snake: SnakeSnapshot): SnakeMotionState {
  return {
    body: snake.body.map((point) => ({ ...point })),
    angle: quantizeSnakeTargetAngle(snake.angle),
    targetAngle: quantizeSnakeTargetAngle(snake.targetAngle ?? snake.angle),
    length: snake.length,
    bodyScale: snake.bodyScale,
    boosting: snake.boosting,
    boostInputHeld: snake.boosting,
    boostFrames: 0,
  };
}

function cloneMotionState(state: SnakeMotionState): SnakeMotionState {
  return {
    body: state.body.map((point) => ({ ...point })),
    angle: state.angle,
    targetAngle: state.targetAngle,
    length: state.length,
    bodyScale: state.bodyScale,
    boosting: state.boosting,
    boostInputHeld: state.boostInputHeld,
    boostFrames: state.boostFrames,
  };
}

function interpolateBody(
  from: ReadonlyArray<Point>,
  to: ReadonlyArray<Point>,
  ratio: number,
): Array<Point> {
  const pointCount = Math.max(from.length, to.length);
  const body: Array<Point> = [];
  for (let index = 0; index < pointCount; index += 1) {
    const start = from[Math.min(index, from.length - 1)];
    const end = to[Math.min(index, to.length - 1)];
    body.push({
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
    });
  }
  return body;
}

function smoothBody(
  from: ReadonlyArray<Point>,
  to: ReadonlyArray<Point>,
  maximumDistance: number,
): Array<Point> {
  return to.map((point, index) =>
    moveToward(from[Math.min(index, from.length - 1)] ?? point, point, maximumDistance),
  );
}

function moveToward(from: Point, to: Point, maximumDistance: number): Point {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance === 0 || distance <= maximumDistance) return { ...to };
  if (maximumDistance <= 0) return { ...from };
  const ratio = maximumDistance / distance;
  return { x: from.x + deltaX * ratio, y: from.y + deltaY * ratio };
}

function smoothAngle(from: number, to: number, maximumTurn: number): number {
  const difference = normalizeSnakeDirectionDelta(to - from);
  if (Math.abs(difference) <= maximumTurn) return to;
  return normalizeAngle(from + Math.sign(difference) * maximumTurn);
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
