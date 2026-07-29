/**
 * 场地边界。
 *
 * 地图为正方形，`arenaHalfSize` 是半边长；食物生成与撞墙判定各有自己的内缩量。
 */

/** 食物与道具生成时距边界的内缩量。 */
export const MAP_BORDER = 16;

/** 撞墙判定系数：蛇头需要没入判定线内这个比例的半径才算撞墙。 */
export const COLLISION_BORDER_DIS_FACTOR = 0.4;

/** 撞墙判定距离，由蛇身半径乘判定系数得出。 */
export function borderCollisionDistance(snakeRadius: number): number {
  return snakeRadius * COLLISION_BORDER_DIS_FACTOR;
}

/** 蛇头是否已越过边界判定线。 */
export function hasCrossedBorder(
  head: { readonly x: number; readonly y: number },
  snakeRadius: number,
  arenaHalfSize: number,
): boolean {
  const distance = borderCollisionDistance(snakeRadius);
  return (
    head.x + arenaHalfSize < distance ||
    arenaHalfSize - head.x < distance ||
    head.y + arenaHalfSize < distance ||
    arenaHalfSize - head.y < distance
  );
}
