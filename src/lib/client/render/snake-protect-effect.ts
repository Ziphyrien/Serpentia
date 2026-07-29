export interface ProtectPathPoint {
  readonly x: number;
  readonly y: number;
}

/** 整蛇保护光罩的包围参数。 */
export const SNAKE_PROTECT_EFFECT = {
  boundsScale: 1.2,
  paddingBodyWidthCount: 6,
  baseBodyWidth: 36,
} as const;

export interface SnakeProtectBounds {
  readonly centerX: number;
  readonly centerY: number;
  readonly size: number;
  readonly halfSize: number;
}

/** 根据身体路径的轴对齐包围盒计算正方形保护光罩。 */
export function snakeProtectBounds(
  body: ReadonlyArray<ProtectPathPoint>,
): SnakeProtectBounds | undefined {
  if (body.length === 0) return undefined;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of body) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const size =
    SNAKE_PROTECT_EFFECT.boundsScale * Math.hypot(width, height) +
    SNAKE_PROTECT_EFFECT.paddingBodyWidthCount * SNAKE_PROTECT_EFFECT.baseBodyWidth;
  return {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    size,
    halfSize: size / 2,
  };
}
