export interface SpeedPathPoint {
  readonly x: number;
  readonly y: number;
}

/** 加速流光的离散路径与贴图参数。 */
export const SNAKE_SPEED_EFFECT = {
  baseBodyWidth: 36,
  frameWidth: 44,
  frameLength: 88,
  pointDistance: 2.25,
  startPointIndex: 10,
  spacingLengthFactor: 1.5,
  movePointCountPerFrame: 3,
  sourceFrameRate: 60,
} as const;

const SOURCE_FRAME_EPSILON = 0.001;

/** 计算相邻流光中心之间的虚拟路径点数。 */
export function speedPeriodPointCount(bodyScale: number): number {
  return Math.floor(
    (SNAKE_SPEED_EFFECT.spacingLengthFactor * SNAKE_SPEED_EFFECT.frameLength * bodyScale) /
      SNAKE_SPEED_EFFECT.pointDistance,
  );
}

/** 逐帧推进离散索引；越过周期时直接回到固定起点。 */
export function advanceSpeedPointIndex(
  pointIndex: number,
  bodyScale: number,
  sourceFrameCount: number,
): number {
  const periodPointCount = speedPeriodPointCount(bodyScale);
  const movePointCount = Math.floor(SNAKE_SPEED_EFFECT.movePointCountPerFrame * bodyScale);
  let nextPointIndex = pointIndex;
  for (let frame = 0; frame < sourceFrameCount; frame += 1) {
    nextPointIndex += movePointCount;
    if (nextPointIndex >= periodPointCount) {
      nextPointIndex = SNAKE_SPEED_EFFECT.startPointIndex;
    }
  }
  return nextPointIndex;
}

/**
 * 将可变刷新率换算到 60 Hz 动画节拍。单次更新最多推进一帧，
 * 高刷新率下通过余数保持平均速度，掉帧后不补跑多帧。
 */
export function accumulateSpeedSourceFrame(
  previousRemainder: number,
  elapsedMs: number,
): { readonly frameCount: 0 | 1; readonly remainder: number } {
  const sourceFrameDurationMs = 1000 / SNAKE_SPEED_EFFECT.sourceFrameRate;
  const elapsedFrameFraction = Math.min(1, Math.max(0, elapsedMs) / sourceFrameDurationMs);
  const accumulated = previousRemainder + elapsedFrameFraction;
  if (accumulated + SOURCE_FRAME_EPSILON < 1) {
    return { frameCount: 0, remainder: accumulated };
  }
  return { frameCount: 1, remainder: Math.max(0, accumulated - 1) };
}

export interface SpeedAnimationState {
  readonly pointIndex: number;
  readonly frameRemainder: number;
  readonly wasBoosting: boolean;
}

/** 更新一次流光动画状态；开启或恢复加速的首帧会立即推进。 */
export function updateSpeedAnimationState(
  state: SpeedAnimationState,
  boosting: boolean,
  bodyScale: number,
  elapsedMs: number,
): SpeedAnimationState {
  if (!boosting) {
    return {
      pointIndex: state.pointIndex,
      frameRemainder: 0,
      wasBoosting: false,
    };
  }

  const sourceFrame = state.wasBoosting
    ? accumulateSpeedSourceFrame(state.frameRemainder, elapsedMs)
    : { frameCount: 1 as const, remainder: 0 };
  return {
    pointIndex: advanceSpeedPointIndex(state.pointIndex, bodyScale, sourceFrame.frameCount),
    frameRemainder: sourceFrame.remainder,
    wasBoosting: true,
  };
}

/**
 * 沿“蛇头 → 蛇尾”的折线路径依次采样流光中心。
 *
 * 采样点的前进方向与尾侧线段相反。恰好落在折点时交给下一条尾侧线段，
 * 避免沿用更靠近蛇头的上一段方向。
 */
export function forEachSpeedPathSample(
  body: ReadonlyArray<SpeedPathPoint>,
  firstDistance: number,
  spacing: number,
  visit: (x: number, y: number, forwardAngle: number) => void,
): void {
  if (body.length < 2 || firstDistance < 0 || spacing <= 0) return;

  let targetDistance = firstDistance;
  let travelled = 0;
  let startX = body[0].x;
  let startY = body[0].y;

  for (let index = 1; index < body.length; index += 1) {
    const endX = body[index].x;
    const endY = body[index].y;
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const segmentLength = Math.hypot(deltaX, deltaY);
    const segmentEnd = travelled + segmentLength;
    const isLastSegment = index === body.length - 1;

    // 非末段使用严格小于：落在折点上的样本应采用下一条尾侧线段的方向。
    while (
      segmentLength > 0 &&
      (targetDistance < segmentEnd || (isLastSegment && targetDistance <= segmentEnd))
    ) {
      const ratio = (targetDistance - travelled) / segmentLength;
      const x = startX + deltaX * ratio;
      const y = startY + deltaY * ratio;
      visit(x, y, Math.atan2(-deltaY, -deltaX));
      targetDistance += spacing;
    }

    travelled = segmentEnd;
    startX = endX;
    startY = endY;
  }
}
