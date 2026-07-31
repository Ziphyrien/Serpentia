import {
  FOOD_ABSORB_DURATION_SECONDS,
  FOOD_ABSORB_SOURCE_FRAME_COUNT,
  FOOD_ABSORB_SOURCE_FRAME_RATE,
} from "$lib/game/food-metrics";
import {
  advanceCollectibleAbsorbTrackingState,
  createCollectibleAbsorbState,
  createCollectibleAbsorbTrackingState,
  sampleCollectibleAbsorbState,
  type CollectibleAbsorbPoint,
  type CollectibleAbsorbSample,
  type CollectibleAbsorbState,
  type CollectibleAbsorbTrackingSample,
  type CollectibleAbsorbTrackingState,
} from "./collectible-absorb-effect";

export type FoodAbsorbPoint = CollectibleAbsorbPoint;

/** 普通食物与残骸被吃后的原版离散飞入参数。 */
export const FOOD_ABSORB_EFFECT = {
  durationSeconds: FOOD_ABSORB_DURATION_SECONDS,
  sourceFrameRate: FOOD_ABSORB_SOURCE_FRAME_RATE,
  sourceFrameCount: FOOD_ABSORB_SOURCE_FRAME_COUNT,
};

export type FoodAbsorbState = CollectibleAbsorbState;
export type FoodAbsorbSample = CollectibleAbsorbSample;
export type FoodAbsorbTrackingState = CollectibleAbsorbTrackingState;
export type FoodAbsorbTrackingSample = CollectibleAbsorbTrackingSample;

export function createFoodAbsorbTrackingState(
  source: FoodAbsorbPoint,
  target: FoodAbsorbPoint,
  startedAtSourceFrame: number,
): FoodAbsorbTrackingState {
  return createCollectibleAbsorbTrackingState(
    source,
    target,
    startedAtSourceFrame,
    FOOD_ABSORB_EFFECT.sourceFrameCount,
  );
}

export function advanceFoodAbsorbTrackingState(
  state: FoodAbsorbTrackingState,
  presentationSourceFrame: number,
  target: FoodAbsorbPoint,
): FoodAbsorbTrackingSample {
  return advanceCollectibleAbsorbTrackingState(state, presentationSourceFrame, target);
}

/**
 * 进入呈现碰撞帧时复制并锁定起点与蛇头目标，完全对应原版 `foodDie/wreckDie`。
 * 之后只使用预先计算的 JavaScript 浮点增量，不追踪后续蛇头。
 */
export function createFoodAbsorbState(
  source: FoodAbsorbPoint,
  target: FoodAbsorbPoint,
  startedAtSourceFrame: number,
): FoodAbsorbState {
  return createCollectibleAbsorbState(
    source,
    target,
    startedAtSourceFrame,
    FOOD_ABSORB_EFFECT.sourceFrameCount,
  );
}

/**
 * 在呈现时间轴上采样原版 12 次离散位移。
 *
 * 碰撞帧本身仍显示起点；下一源帧执行第一次位移。第 12 次位移完成后同次回收，
 * 目标帧不会额外停留。逐次相加保持原版 JavaScript 浮点运算顺序。
 */
export function sampleFoodAbsorbState(
  state: FoodAbsorbState,
  presentationSourceFrame: number,
): FoodAbsorbSample {
  return sampleCollectibleAbsorbState(state, presentationSourceFrame);
}
