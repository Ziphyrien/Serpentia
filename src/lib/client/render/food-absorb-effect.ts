import {
  FOOD_ABSORB_DURATION_SECONDS,
  FOOD_ABSORB_SOURCE_FRAME_COUNT,
  FOOD_ABSORB_SOURCE_FRAME_RATE,
} from "$lib/game/food-metrics";

export interface FoodAbsorbPoint {
  readonly x: number;
  readonly y: number;
}

/** 普通食物与残骸被吃后的原版离散飞入参数。 */
export const FOOD_ABSORB_EFFECT = {
  durationSeconds: FOOD_ABSORB_DURATION_SECONDS,
  sourceFrameRate: FOOD_ABSORB_SOURCE_FRAME_RATE,
  sourceFrameCount: FOOD_ABSORB_SOURCE_FRAME_COUNT,
};

const SOURCE_FRAME_EPSILON = 0.000_001;

export interface FoodAbsorbState {
  readonly source: FoodAbsorbPoint;
  readonly target: FoodAbsorbPoint;
  readonly delta: FoodAbsorbPoint;
  /** 权威碰撞进入画面的绝对 60 Hz 呈现源帧。 */
  readonly startedAtSourceFrame: number;
}

export interface FoodAbsorbSample {
  readonly position: FoodAbsorbPoint;
  readonly completedSourceFrames: number;
  readonly started: boolean;
  readonly complete: boolean;
}

export interface FoodAbsorbTrackingState {
  readonly position: FoodAbsorbPoint;
  readonly target: FoodAbsorbPoint;
  readonly completedSourceFrames: number;
  readonly startedAtSourceFrame: number;
}

export interface FoodAbsorbTrackingSample extends FoodAbsorbSample {
  readonly state: FoodAbsorbTrackingState;
}

export function createFoodAbsorbTrackingState(
  source: FoodAbsorbPoint,
  target: FoodAbsorbPoint,
  startedAtSourceFrame: number,
): FoodAbsorbTrackingState {
  return {
    position: { x: source.x, y: source.y },
    target: { x: target.x, y: target.y },
    completedSourceFrames: 0,
    startedAtSourceFrame,
  };
}

/**
 * 联网本机呈现按当前蛇头重定向，但仍严格只执行 12 次离散位移。
 * 每一步除以剩余帧数；静止目标时与原版固定 `(target-source)/12` 完全等价，
 * 移动目标则保证第 12 步落在该步传入的蛇头上。
 */
export function advanceFoodAbsorbTrackingState(
  state: FoodAbsorbTrackingState,
  presentationSourceFrame: number,
  target: FoodAbsorbPoint,
): FoodAbsorbTrackingSample {
  const elapsed = presentationSourceFrame - state.startedAtSourceFrame;
  const started = Number.isFinite(elapsed) && elapsed + SOURCE_FRAME_EPSILON >= 0;
  const desiredSourceFrames = started
    ? Math.min(
        FOOD_ABSORB_EFFECT.sourceFrameCount,
        Math.max(0, Math.floor(elapsed + SOURCE_FRAME_EPSILON)),
      )
    : 0;
  let x = state.position.x;
  let y = state.position.y;
  let completedSourceFrames = state.completedSourceFrames;
  while (completedSourceFrames < desiredSourceFrames) {
    const remainingSourceFrames = FOOD_ABSORB_EFFECT.sourceFrameCount - completedSourceFrames;
    x += (target.x - x) / remainingSourceFrames;
    y += (target.y - y) / remainingSourceFrames;
    completedSourceFrames += 1;
  }

  const nextState: FoodAbsorbTrackingState = {
    position: { x, y },
    target: { x: target.x, y: target.y },
    completedSourceFrames,
    startedAtSourceFrame: state.startedAtSourceFrame,
  };
  return {
    state: nextState,
    position: nextState.position,
    completedSourceFrames,
    started,
    complete: completedSourceFrames >= FOOD_ABSORB_EFFECT.sourceFrameCount,
  };
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
  return {
    source: { x: source.x, y: source.y },
    target: { x: target.x, y: target.y },
    delta: {
      x: (target.x - source.x) / FOOD_ABSORB_EFFECT.sourceFrameCount,
      y: (target.y - source.y) / FOOD_ABSORB_EFFECT.sourceFrameCount,
    },
    startedAtSourceFrame,
  };
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
  const elapsed = presentationSourceFrame - state.startedAtSourceFrame;
  const started = Number.isFinite(elapsed) && elapsed + SOURCE_FRAME_EPSILON >= 0;
  const completedSourceFrames = started
    ? Math.min(
        FOOD_ABSORB_EFFECT.sourceFrameCount,
        Math.max(0, Math.floor(elapsed + SOURCE_FRAME_EPSILON)),
      )
    : 0;

  let x = state.source.x;
  let y = state.source.y;
  for (let frame = 0; frame < completedSourceFrames; frame += 1) {
    x += state.delta.x;
    y += state.delta.y;
  }

  return {
    position: { x, y },
    completedSourceFrames,
    started,
    complete: completedSourceFrames >= FOOD_ABSORB_EFFECT.sourceFrameCount,
  };
}
