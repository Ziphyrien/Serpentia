import {
  STAR_FOOD_DIRECTION_FRAME_MAX_EXCLUSIVE,
  STAR_FOOD_DIRECTION_FRAME_MIN,
} from "$lib/game/food-metrics";
import { normalGameDegreesToRadians } from "$lib/game/normal-game-math";

export const DECORATIVE_STAR_SOURCE_FRAME_RATE = 60;
export const DECORATIVE_STAR_MOVE_DISTANCE_PER_SOURCE_FRAME = 0.45;

export interface DecorativeStarState {
  readonly x: number;
  readonly y: number;
  readonly directionDegrees: number;
  readonly linearFramesRemaining: number;
}

export interface DecorativeStarBounds {
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

/** 首页星星复用游戏星星的直线段与边界转向语义，仅缩放每帧位移。 */
export function advanceDecorativeStarSourceFrame(
  state: DecorativeStarState,
  bounds: DecorativeStarBounds,
  nextDirectionDegrees: number,
  nextLinearFramesRemaining: number,
): DecorativeStarState {
  let directionDegrees = normalizeDegrees(state.directionDegrees);
  let linearFramesRemaining = state.linearFramesRemaining - 1;
  if (linearFramesRemaining <= 0) {
    directionDegrees = normalizeDegrees(nextDirectionDegrees);
    linearFramesRemaining = normalizeLinearFrames(nextLinearFramesRemaining);
  }

  if (state.x - bounds.radius < 0) {
    directionDegrees = 0;
    linearFramesRemaining = normalizeLinearFrames(nextLinearFramesRemaining);
  } else if (state.y + bounds.radius > bounds.height) {
    directionDegrees = 270;
    linearFramesRemaining = normalizeLinearFrames(nextLinearFramesRemaining);
  } else if (state.x + bounds.radius > bounds.width) {
    directionDegrees = 180;
    linearFramesRemaining = normalizeLinearFrames(nextLinearFramesRemaining);
  } else if (state.y - bounds.radius < 0) {
    directionDegrees = 90;
    linearFramesRemaining = normalizeLinearFrames(nextLinearFramesRemaining);
  }

  const radians = normalGameDegreesToRadians(directionDegrees);
  return {
    x: state.x + Math.cos(radians) * DECORATIVE_STAR_MOVE_DISTANCE_PER_SOURCE_FRAME,
    y: state.y + Math.sin(radians) * DECORATIVE_STAR_MOVE_DISTANCE_PER_SOURCE_FRAME,
    directionDegrees,
    linearFramesRemaining,
  };
}

export function clampDecorativeStarToBounds(
  state: DecorativeStarState,
  bounds: DecorativeStarBounds,
): DecorativeStarState {
  const centerX = bounds.width / 2;
  const centerY = bounds.height / 2;
  const minimumX = bounds.radius;
  const maximumX = bounds.width - bounds.radius;
  const minimumY = bounds.radius;
  const maximumY = bounds.height - bounds.radius;
  return {
    ...state,
    x: minimumX <= maximumX ? Math.min(maximumX, Math.max(minimumX, state.x)) : centerX,
    y: minimumY <= maximumY ? Math.min(maximumY, Math.max(minimumY, state.y)) : centerY,
  };
}

export function randomDecorativeStarLinearFrames(randomValue: number): number {
  const normalized = Math.min(1 - Number.EPSILON, Math.max(0, randomValue));
  return Math.floor(
    STAR_FOOD_DIRECTION_FRAME_MIN +
      normalized * (STAR_FOOD_DIRECTION_FRAME_MAX_EXCLUSIVE - STAR_FOOD_DIRECTION_FRAME_MIN),
  );
}

function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function normalizeLinearFrames(frames: number): number {
  return Math.min(
    STAR_FOOD_DIRECTION_FRAME_MAX_EXCLUSIVE - 1,
    Math.max(STAR_FOOD_DIRECTION_FRAME_MIN, Math.floor(frames)),
  );
}
