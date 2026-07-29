import type { Point } from "../../protocol/state";

export type {
  DeathCause,
  DeathEvent,
  FoodConsumedEvent,
  FoodKind,
  FoodState,
  GameSnapshot,
  Point,
  SnakeSnapshot,
  TickEvents,
} from "../../protocol/state";

export interface SnakeState {
  readonly id: string;
  nickname: string;
  /** 权威内置皮肤 ID，由会话选择并经清单校验。 */
  skinId: number;
  body: Array<Point>;
  angle: number;
  targetAngle: number;
  /** 逻辑长度，同时是分数基准；身体点数由分段表换算。 */
  length: number;
  /** 原版带迟滞的当前身体缩放档位。 */
  bodyScale: number;
  score: number;
  kills: number;
  /** 当前实际加速状态，不是未经长度门槛判定的按键意图。 */
  boosting: boolean;
  /** 当前聚合加速输入是否保持按下，用于复刻原版按下沿门槛。 */
  boostInputHeld: boolean;
  /** 已连续累计的加速源帧数。 */
  boostFrames: number;
  alive: boolean;
  respawnAtTick: number | undefined;
  /** 保护截止源帧（半开区间，不包含该源帧）。 */
  invulnerableUntilSourceFrame: number;
  lastInputSequence: number;
  lastInputAppliedTick: number;
}

export interface PlayerInput {
  readonly playerId: string;
  readonly sequence: number;
  readonly angle: number;
  readonly boosting: boolean;
  readonly appliedTick?: number;
}
