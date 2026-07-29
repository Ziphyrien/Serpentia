import { NORMAL_GAME_PI, NORMAL_GAME_TAU, normalGameDegreesToRadians } from "./normal-game-math";

export interface MotionPoint {
  x: number;
  y: number;
}

export interface SnakeMotionState {
  /** 固定间距的身体路径点，索引 0 是蛇头。 */
  body: Array<MotionPoint>;
  angle: number;
  targetAngle: number;
  /** 逻辑长度，同时是分数基准；通过分段表换算出身体点数。 */
  length: number;
  /** 原版有迟滞的当前身体缩放档位，不可由当前长度即时反推。 */
  bodyScale: number;
  /** 当前实际是否处于加速；原版只在按下沿尝试进入。 */
  boosting: boolean;
  /** 聚合加速输入是否仍按住；长度不足时失败的按下不能在进食后自动重试。 */
  boostInputHeld: boolean;
  /** 已连续累计的加速源帧数，达到阈值才扣 1 点逻辑长度。 */
  boostFrames: number;
}

/** 逻辑长度换算身体点数的分段表。 */
export interface LengthStep {
  readonly maxLength: number;
  readonly stepLength: number;
}

export interface SnakeMotionRules {
  /** 相邻身体点之间的固定世界间距。 */
  readonly pointSpacing: number;
  /** 每个权威 tick 内推进的逻辑源帧数。 */
  readonly sourceFramesPerTick: number;
  /** 普通状态每源帧前进的身体点数。 */
  readonly pointsPerFrame: number;
  /** 加速状态每源帧前进的身体点数。 */
  readonly boostPointsPerFrame: number;
  /** 每源帧的最大转向角（弧度）。 */
  readonly turnPerFrame: number;
  /** 每源帧最多补齐的身体点数，长度突增时身体逐帧跟上。 */
  readonly growthPointsPerFrame: number;
  readonly minimumLength: number;
  /** 原版新无尽的身体点数封顶长度，不是逻辑 length 的写入上限。 */
  readonly maximumLength: number;
  /** 连续加速满这么多源帧后，下一帧扣 1 点逻辑长度。 */
  readonly boostDrainFrames: number;
  readonly lengthSteps: ReadonlyArray<LengthStep>;
}

const TAU = Math.PI * 2;
const FIXED_PRECISION = 1_000;

/**
 * 逻辑长度到身体点数的分段表。
 *
 * 长度越大，每一「步」代表的长度越多，身体因此不会随分数线性变长。
 * `18900` 出现两次，第二段区间宽度为 0、不产生步数，保留以维持分段边界一致。
 */
const LENGTH_STEP_TABLE: ReadonlyArray<readonly [number, number]> = [
  [300, 3],
  [600, 4],
  [900, 5],
  [1200, 6],
  [1500, 7],
  [1800, 8],
  [2100, 9],
  [2400, 10],
  [2700, 11],
  [3000, 12],
  [3300, 13],
  [3600, 14],
  [3900, 15],
  [4200, 16],
  [4500, 17],
  [4800, 18],
  [5100, 19],
  [5400, 20],
  [5700, 21],
  [6000, 22],
  [6300, 23],
  [6600, 24],
  [6900, 25],
  [7200, 26],
  [7500, 27],
  [7800, 28],
  [8100, 29],
  [8400, 30],
  [8700, 31],
  [9000, 32],
  [9300, 33],
  [9600, 34],
  [9900, 35],
  [10200, 36],
  [10500, 37],
  [10800, 38],
  [11100, 39],
  [11400, 40],
  [11700, 41],
  [12000, 42],
  [12300, 43],
  [12600, 44],
  [12900, 45],
  [13200, 46],
  [13500, 47],
  [13800, 48],
  [14100, 49],
  [14400, 50],
  [14700, 51],
  [15000, 52],
  [15300, 53],
  [15600, 54],
  [15900, 55],
  [16200, 56],
  [16500, 57],
  [16800, 58],
  [17100, 59],
  [17400, 60],
  [17700, 61],
  [18000, 62],
  [18300, 63],
  [18600, 64],
  [18900, 65],
  [18900, 66],
  [19200, 67],
  [19500, 68],
  [19800, 69],
  [20100, 70],
  [100000, 50],
  [200000, 100],
  [300000, 100],
];

export const LENGTH_STEPS: ReadonlyArray<LengthStep> = LENGTH_STEP_TABLE.map(
  ([maxLength, stepLength]) => ({ maxLength, stepLength }),
);

/** 每一「步」对应的身体点数。 */
export const POINTS_PER_STEP = 2;

/** 逻辑模拟的固定常量，与权威 tick 频率无关。 */
export const SNAKE_MOTION = {
  /** 身体点距：单帧移动距离 4.5 除以每帧步进点数 2。 */
  pointSpacing: 2.25,
  /** 逻辑帧率；20 Hz 权威 tick 每次推进 3 个源帧。 */
  sourceFrameRate: 60,
  pointsPerFrame: 1 * POINTS_PER_STEP,
  boostPointsPerFrame: 2 * POINTS_PER_STEP,
  turnPerFrame: normalGameDegreesToRadians(10),
  growthPointsPerFrame: POINTS_PER_STEP,
  boostDrainFrames: 20,
} as const;

/** 原版无尽模式的身体缩放与身体宽度。 */
export const SNAKE_BODY = {
  /** `GameConstant.SNAKE_BODY_WIDTH`：渲染、进食、边界与蛇碰撞共用的基准宽度。 */
  width: 36,
  initialScale: 1,
  maximumScale: 2.8,
  /** 达到该逻辑长度时目标身体缩放到达上限。 */
  scaleMaxLength: 100_000,
  /** 目标比例与当前比例严格相差超过该值时才重新计算皮肤尺寸。 */
  scaleUpdateThreshold: 0.1,
  /** 蛇头与另一条蛇身体点之间的判定距离倍率。 */
  snakeCollisionDistanceFactor: 0.5,
} as const;

/** 分段身体点数累计使用的三位精度；运动坐标保持正常 Game 的原生浮点。 */
export function fixed(value: number, precision = FIXED_PRECISION): number {
  return Math.round(value * precision) / precision;
}

export interface SnakeMotionBounds {
  readonly tickRate: number;
  readonly minimumLength: number;
  /** 身体采样点数的计算上限。 */
  readonly maximumLength: number;
}

/** 把长度边界与 tick 频率组合成一套完整运动规则。 */
export function snakeMotionRules(bounds: SnakeMotionBounds): SnakeMotionRules {
  return {
    pointSpacing: SNAKE_MOTION.pointSpacing,
    sourceFramesPerTick: Math.max(1, Math.round(SNAKE_MOTION.sourceFrameRate / bounds.tickRate)),
    pointsPerFrame: SNAKE_MOTION.pointsPerFrame,
    boostPointsPerFrame: SNAKE_MOTION.boostPointsPerFrame,
    turnPerFrame: SNAKE_MOTION.turnPerFrame,
    growthPointsPerFrame: SNAKE_MOTION.growthPointsPerFrame,
    boostDrainFrames: SNAKE_MOTION.boostDrainFrames,
    minimumLength: bounds.minimumLength,
    maximumLength: bounds.maximumLength,
    lengthSteps: LENGTH_STEPS,
  };
}

/** 正常 `Game/Snake` 直接使用 JavaScript 浮点斜率，不经过锁步版定点化。 */
export function snakeBodyScaleFactor(minimumLength: number): number {
  const span = SNAKE_BODY.scaleMaxLength - minimumLength;
  if (span <= 0) return 0;
  return (SNAKE_BODY.maximumScale - SNAKE_BODY.initialScale) / span;
}

/** 由逻辑长度计算正常新无尽的连续目标缩放。 */
export function targetSnakeBodyScale(length: number, minimumLength: number): number {
  const scale =
    length < SNAKE_BODY.scaleMaxLength
      ? SNAKE_BODY.initialScale + (length - minimumLength) * snakeBodyScaleFactor(minimumLength)
      : SNAKE_BODY.maximumScale;
  return Math.min(scale, SNAKE_BODY.maximumScale);
}

/** 保留当前缩放，直到它与正常 `Game/Snake` 浮点目标严格相差超过 `0.1`。 */
export function nextSnakeBodyScale(
  currentScale: number,
  length: number,
  minimumLength: number,
): number {
  const targetScale = targetSnakeBodyScale(length, minimumLength);
  return !currentScale || Math.abs(currentScale - targetScale) > SNAKE_BODY.scaleUpdateThreshold
    ? targetScale
    : currentScale;
}

/** 当前档位对应的原版身体宽度。 */
export function snakeBodyWidth(bodyScale: number): number {
  return SNAKE_BODY.width * bodyScale;
}

/** 进食与边界判定使用身体宽度的一半。 */
export function snakeBodyRadius(bodyScale: number): number {
  return snakeBodyWidth(bodyScale) / 2;
}

/** 两条蛇之间的原版碰撞距离，包含 `COLLISION_SNAKE_DIS_FACTOR = 0.5`。 */
export function snakeCollisionDistance(leftScale: number, rightScale: number): number {
  return (
    ((snakeBodyWidth(leftScale) + snakeBodyWidth(rightScale)) / 2) *
    SNAKE_BODY.snakeCollisionDistanceFactor
  );
}

export function normalizeAngle(angle: number): number {
  const normalized = ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return normalized === -Math.PI ? Math.PI : normalized;
}

/**
 * 正常 Game 输入先经 `MathUtil.getVectorDegree()` 四舍五入成整数度。
 * 保留正向得到的 360°：它与 0° 位置相同，但原版恰好半圈时会保留差值符号。
 */
function originalSnakeDirectionDegrees(angle: number): number {
  let degrees = Math.round((angle / NORMAL_GAME_PI) * 180);
  while (degrees < 0) degrees += 360;
  while (degrees > 360) degrees -= 360;
  return degrees;
}

export function quantizeSnakeTargetAngle(angle: number): number {
  return normalGameDegreesToRadians(originalSnakeDirectionDegrees(angle));
}

/** 在原版 6.28 方向域内取得最短差值；恰好半圈时保留符号。 */
export function normalizeSnakeDirectionDelta(delta: number): number {
  let normalized = delta % NORMAL_GAME_TAU;
  if (normalized > NORMAL_GAME_PI) normalized -= NORMAL_GAME_TAU;
  else if (normalized < -NORMAL_GAME_PI) normalized += NORMAL_GAME_TAU;
  return normalized;
}

export function turnTowards(current: number, target: number, maximumTurn: number): number {
  // 原版 direction 始终在 0°..360° 域内；不能先折到 ±180°，否则
  // 当前 270°、目标 90° 这一半圈会从原版的负方向错误变成正方向。
  const currentDegrees = originalSnakeDirectionDegrees(current);
  const targetDegrees = originalSnakeDirectionDegrees(target);
  const maximumTurnDegrees = Math.round((maximumTurn / NORMAL_GAME_PI) * 180);
  let difference = targetDegrees - currentDegrees;
  // 严格大于半圈才换边；恰好 ±180° 保留原始差值符号。
  if (difference > 180) difference -= 360;
  else if (difference < -180) difference += 360;

  let nextDegrees =
    Math.abs(difference) < maximumTurnDegrees
      ? targetDegrees
      : currentDegrees + Math.sign(difference) * maximumTurnDegrees;
  if (nextDegrees < 0) nextDegrees += 360;
  else if (nextDegrees > 360) nextDegrees -= 360;
  return normalGameDegreesToRadians(nextDegrees);
}

/** 逐段累加 `长度差 / stepLength`，取整后乘以每步点数。 */
export function bodyPointCount(length: number, rules: SnakeMotionRules): number {
  const clamped = Math.min(Math.max(0, length), rules.maximumLength);
  let steps = 0;
  let previousMaximum = 0;
  for (const step of rules.lengthSteps) {
    steps = fixed(steps + (Math.min(clamped, step.maxLength) - previousMaximum) / step.stepLength);
    if (clamped <= step.maxLength) break;
    previousMaximum = step.maxLength;
  }
  return Math.max(2, Math.floor(steps) * POINTS_PER_STEP);
}

/** 身体的世界弧长，由点数与固定点距共同决定。 */
export function bodyArcLength(length: number, rules: SnakeMotionRules): number {
  return (bodyPointCount(length, rules) - 1) * rules.pointSpacing;
}

/**
 * 把身体点数向目标数量靠拢。
 *
 * 缩短一次到位；伸长每帧最多补 `growthLimit` 个点，长度突增时身体逐帧跟上。
 */
export function resizeBody(
  body: Array<MotionPoint>,
  pointCount: number,
  growthLimit = Number.POSITIVE_INFINITY,
): void {
  if (body.length === 0) return;
  while (body.length > pointCount) body.pop();
  let added = 0;
  while (body.length < pointCount && added < growthLimit) {
    const tail = body[body.length - 1];
    body.push({ x: tail.x, y: tail.y });
    added += 1;
  }
}

/**
 * 应用一次聚合加速输入。
 *
 * 原版 `Game/Snake.speedUp()` 只在按下事件发生时检查长度：若当时处于最短长度，
 * 这次按下直接失效；持续按住期间即使进食也不会自动重试，必须先松开再按下。
 */
export function applySnakeBoostInput(
  state: Pick<SnakeMotionState, "length" | "boosting" | "boostInputHeld" | "boostFrames">,
  pressed: boolean,
  minimumLength: number,
): void {
  const pressedThisInput = pressed && !state.boostInputHeld;
  state.boostInputHeld = pressed;
  if (!pressed) {
    state.boosting = false;
    state.boostFrames = 0;
    return;
  }
  if (pressedThisInput && state.length > minimumLength) {
    state.boosting = true;
    state.boostFrames = 0;
  }
}

export function willDrainBoostSourceFrame(
  state: Pick<SnakeMotionState, "length" | "boosting" | "boostFrames">,
  rules: Pick<SnakeMotionRules, "minimumLength" | "boostDrainFrames">,
): boolean {
  return (
    state.boosting &&
    state.length > rules.minimumLength &&
    state.boostFrames + 1 > rules.boostDrainFrames
  );
}

/** 推进一个原版 60 Hz 源帧，返回这一帧因加速扣掉的逻辑长度。 */
export function advanceSnakeSourceFrame(state: SnakeMotionState, rules: SnakeMotionRules): number {
  state.angle = turnTowards(state.angle, state.targetAngle, rules.turnPerFrame);

  let drained = 0;
  const drainsThisFrame = willDrainBoostSourceFrame(state, rules);
  let boosting = state.boosting && state.length > rules.minimumLength;
  if (!boosting && state.boosting) state.boosting = false;
  if (boosting) {
    state.boostFrames += 1;
    if (drainsThisFrame) {
      state.boostFrames = 0;
      state.length = Math.round(state.length - 1);
      drained = 1;
      // 原版先在 processSpeedUp 中触底并 speedDown，再由 updateSnakePoints 移动。
      if (state.length <= rules.minimumLength) {
        state.boosting = false;
        boosting = false;
      }
    }
  } else {
    state.boostFrames = 0;
  }

  resizeBody(state.body, bodyPointCount(state.length, rules), rules.growthPointsPerFrame);

  const points = boosting ? rules.boostPointsPerFrame : rules.pointsPerFrame;
  const stepX = rules.pointSpacing * Math.cos(state.angle);
  const stepY = rules.pointSpacing * Math.sin(state.angle);
  for (let step = 0; step < points; step += 1) {
    const head = state.body[0];
    const recycled = state.body.pop();
    const next = { x: head.x + stepX, y: head.y + stepY };
    if (recycled === undefined) {
      state.body.unshift(next);
      continue;
    }
    recycled.x = next.x;
    recycled.y = next.y;
    state.body.unshift(recycled);
  }

  // 原版先移动身体，再根据这一源帧结束时的逻辑长度更新缩放档位。
  state.bodyScale = nextSnakeBodyScale(state.bodyScale, state.length, rules.minimumLength);
  return drained;
}

/** 推进一个权威 tick（内部按源帧离散推进），返回本 tick 因加速扣掉的逻辑长度。 */
export function advanceSnakeMotion(state: SnakeMotionState, rules: SnakeMotionRules): number {
  let drained = 0;
  for (let frame = 0; frame < rules.sourceFramesPerTick; frame += 1) {
    drained += advanceSnakeSourceFrame(state, rules);
  }
  return drained;
}

/** 沿蛇头反方向铺出一条初始直线身体。 */
export function createBody(
  position: MotionPoint,
  angle: number,
  length: number,
  rules: SnakeMotionRules,
): Array<MotionPoint> {
  const pointCount = bodyPointCount(length, rules);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const body: Array<MotionPoint> = [];
  for (let index = 0; index < pointCount; index += 1) {
    body.push({
      x: position.x - rules.pointSpacing * index * cosine,
      y: position.y - rules.pointSpacing * index * sine,
    });
  }
  return body;
}
