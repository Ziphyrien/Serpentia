import type { FoodKind } from "../protocol/state";

/** `Food.foodDie` / `Wreck.wreckDie` 的原版持续时间。 */
export const FOOD_ABSORB_DURATION_SECONDS = 0.2;

/** 原版游戏逻辑帧率，以及 0.2 秒对应的离散更新次数。 */
export const FOOD_ABSORB_SOURCE_FRAME_RATE = 60;
export const FOOD_ABSORB_SOURCE_FRAME_COUNT = Math.round(
  FOOD_ABSORB_DURATION_SECONDS * FOOD_ABSORB_SOURCE_FRAME_RATE,
);

/** 星星食物每个 60 Hz 源帧的移动距离。 */
export const STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME = 3;

/** 随机方向持续帧数由 `getRandom(100, 200)` 生成，最大值不含 200。 */
export const STAR_FOOD_DIRECTION_FRAME_MIN = 100;
export const STAR_FOOD_DIRECTION_FRAME_MAX_EXCLUSIVE = 200;

/** `MapUtil.randomSafeXY` 重生时每条坐标轴避开旧位置的距离。 */
export const FOOD_RESPAWN_SAFE_DISTANCE = 100;

/**
 * 食物与残骸的几何。
 *
 * 彩点、星星、加速掉落残骸尺寸固定；死亡残骸尺寸随每份分数放大，
 * 因此半径必须由 `value` 推出，不能写成常量。
 */
export const FOOD_VARIANT_COUNT = {
  dot: 7,
  candy: 20,
} as const;

export const FOOD_SIZE = {
  /** 彩点显示直径。 */
  dot: 16,
  /** 星星显示直径。 */
  star: 42,
  /** 加速掉落残骸直径，固定不缩放。 */
  boostRemains: 22,
  /** 死亡残骸基准直径，实际按每份分数放大 1~2 倍。 */
  deadRemains: 34,
} as const;

/** 死亡残骸对象携带的官方原始长度值 3；正常新无尽 actAsEndless() 不用它结算。 */
export const DEAD_REMAINS_LENGTH_VALUE = 3;

/** 死亡残骸每份的基准分数，同时是尺寸缩放的分母。 */
export const DEAD_REMAINS_BASE_VALUE = 3;

/** 死亡残骸尺寸缩放上限。 */
export const DEAD_REMAINS_MAX_SCALE = 2;

export interface FoodRadiusRules {
  /** 取值达到这个门槛的环境食物按星星处理。 */
  readonly starFoodValue: number;
}

export interface FoodShape {
  readonly kind: FoodKind;
  readonly value: number;
}

export function isStarFood(food: FoodShape, rules: FoodRadiusRules): boolean {
  return food.kind === "ambient" && food.value >= rules.starFoodValue;
}

/** 旧无尽中复用 `playEatWreckAudio` 的食物：星星与非 drop 死亡残骸。 */
export function usesEatWreckAudio(food: FoodShape, rules: FoodRadiusRules): boolean {
  return food.kind === "remains" || isStarFood(food, rules);
}

/** 死亡残骸每份分数越高体积越大，上限 2 倍。 */
export function deadRemainsScale(value: number): number {
  const scale = value / DEAD_REMAINS_BASE_VALUE;
  return Math.min(DEAD_REMAINS_MAX_SCALE, Math.max(1, scale));
}

export function foodDiameterOf(food: FoodShape, rules: FoodRadiusRules): number {
  switch (food.kind) {
    case "boost-remains":
      return FOOD_SIZE.boostRemains;
    case "remains":
      return FOOD_SIZE.deadRemains * deadRemainsScale(food.value);
    default:
      return isStarFood(food, rules) ? FOOD_SIZE.star : FOOD_SIZE.dot;
  }
}

export function foodRadiusOf(food: FoodShape, rules: FoodRadiusRules): number {
  return foodDiameterOf(food, rules) / 2;
}

/** 判定与空间查询用的最大食物半径。 */
export function maximumFoodRadius(): number {
  return (FOOD_SIZE.deadRemains * DEAD_REMAINS_MAX_SCALE) / 2;
}

/**
 * 进食接触距离：两个半径之和整体乘以判定倍率。
 *
 * 倍率作用在半径和上，而不是只放大蛇头半径。
 */
export function eatContactDistance(
  snakeRadius: number,
  foodRadius: number,
  eatDistanceFactor: number,
): number {
  return (snakeRadius + foodRadius) * eatDistanceFactor;
}
