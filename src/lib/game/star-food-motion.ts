import type { FoodState, Point } from "$lib/protocol";
import { STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME } from "./food-metrics";
import { normalGameDegreesToRadians } from "./normal-game-math";

/**
 * 紧凑快照把坐标量化为 1/4 世界单位；两端相对误差再留少量转向余量。
 * 仅用于客户端预测门槛，不改变服务端原版碰撞半径。
 */
export const FOOD_PREDICTION_CONTACT_GUARD = 0.5;

/**
 * 将最新权威食物推进到本机离散碰撞源帧。
 *
 * 静止食物可直接复用权威坐标。星星只有在当前直线段覆盖目标帧，且这段轨迹
 * 不会接近边界转向区时才可预测；未来随机换向无法由客户端确定，必须等待权威事件。
 */
export function predictFoodCollisionPosition(
  food: FoodState,
  authoritativeSourceFrame: number,
  collisionSourceFrame: number,
  arenaExtent: number,
  foodRadius: number,
): Point | undefined {
  if (!Number.isInteger(authoritativeSourceFrame) || !Number.isInteger(collisionSourceFrame)) {
    return undefined;
  }
  return predictKnownFoodPosition(
    food,
    authoritativeSourceFrame,
    collisionSourceFrame,
    arenaExtent,
    foodRadius,
  );
}

/** 将星星连续推进到与本机蛇头相同的可含小数呈现源帧。 */
export function predictFoodPresentationPosition(
  food: FoodState,
  authoritativeSourceFrame: number,
  presentationSourceFrame: number,
  arenaExtent: number,
  foodRadius: number,
): Point | undefined {
  if (
    !Number.isInteger(authoritativeSourceFrame) ||
    !Number.isFinite(presentationSourceFrame) ||
    presentationSourceFrame < authoritativeSourceFrame
  ) {
    return undefined;
  }

  const frameCount = presentationSourceFrame - authoritativeSourceFrame;
  const motion = food.motion;
  // Static food never needs a presented position. Returning undefined lets the
  // renderer reuse the authoritative FoodState instead of cloning it per frame.
  if (motion === undefined) return undefined;
  if (frameCount === 0) return { ...food.position };

  // 倒计时为 R 时，前 R-1 帧仍沿当前方向；第 R 帧会先随机换向再移动。
  const knownStraightFrames = Math.max(0, motion.linearFramesRemaining - 1);
  const radians = normalGameDegreesToRadians(motion.directionDegrees);
  const velocityX = Math.cos(radians) * STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME;
  const velocityY = Math.sin(radians) * STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME;
  const safeExtent = arenaExtent - foodRadius - STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME;
  const boundaryFrames = framesUntilPresentationBoundary(
    food.position,
    velocityX,
    velocityY,
    safeExtent,
  );
  const predictableFrames = Math.min(frameCount, knownStraightFrames, boundaryFrames);
  return {
    x: food.position.x + velocityX * predictableFrames,
    y: food.position.y + velocityY * predictableFrames,
  };
}

function predictKnownFoodPosition(
  food: FoodState,
  authoritativeSourceFrame: number,
  targetSourceFrame: number,
  arenaExtent: number,
  foodRadius: number,
): Point | undefined {
  if (targetSourceFrame < authoritativeSourceFrame) {
    return undefined;
  }

  const frameCount = targetSourceFrame - authoritativeSourceFrame;
  const motion = food.motion;
  // Static coordinates are immutable protocol data; reuse them to avoid one
  // collision candidate allocation per food per presentation frame.
  if (motion === undefined) return food.position;
  if (frameCount === 0) return { ...food.position };
  if (frameCount >= motion.linearFramesRemaining) return undefined;

  const radians = normalGameDegreesToRadians(motion.directionDegrees);
  const position = {
    x: food.position.x + Math.cos(radians) * STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME * frameCount,
    y: food.position.y + Math.sin(radians) * STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME * frameCount,
  };

  // 原版边界 rect 落后一源帧；额外退让一帧距离才能保证这段轨迹不会触发转向。
  const safeExtent = arenaExtent - foodRadius - STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME;
  if (
    safeExtent < 0 ||
    Math.abs(food.position.x) > safeExtent ||
    Math.abs(food.position.y) > safeExtent ||
    Math.abs(position.x) > safeExtent ||
    Math.abs(position.y) > safeExtent
  ) {
    return undefined;
  }
  return position;
}

function framesUntilPresentationBoundary(
  position: Point,
  velocityX: number,
  velocityY: number,
  safeExtent: number,
): number {
  if (safeExtent < 0 || Math.abs(position.x) > safeExtent || Math.abs(position.y) > safeExtent) {
    return 0;
  }

  let frames = Number.POSITIVE_INFINITY;
  if (velocityX > 0) frames = Math.min(frames, (safeExtent - position.x) / velocityX);
  if (velocityX < 0) frames = Math.min(frames, (-safeExtent - position.x) / velocityX);
  if (velocityY > 0) frames = Math.min(frames, (safeExtent - position.y) / velocityY);
  if (velocityY < 0) frames = Math.min(frames, (-safeExtent - position.y) / velocityY);
  return Math.max(0, frames);
}
