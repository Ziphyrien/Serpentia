import { Schema } from "effect";

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Nickname = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

export const PlayerId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
);
export type PlayerId = typeof PlayerId.Type;

export const Point = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
});
export type Point = typeof Point.Type;

export const FoodKind = Schema.Union([
  Schema.Literal("ambient"),
  /** 死亡残骸：按身体点数分份，尺寸随每份分数放大。 */
  Schema.Literal("remains"),
  /** 加速掉落残骸：固定尺寸与取值，落在蛇尾。 */
  Schema.Literal("boost-remains"),
]);
export type FoodKind = typeof FoodKind.Type;

export const StarFoodMotion = Schema.Struct({
  /** 原版星星当前移动方向，整数角度 [0, 359]。 */
  directionDegrees: NonNegativeInteger.check(Schema.isLessThan(360)),
  /** 从当前快照起，仍能确定保持当前直线方向的源帧数。 */
  linearFramesRemaining: NonNegativeInteger,
});
export type StarFoodMotion = typeof StarFoodMotion.Type;

export const FoodState = Schema.Struct({
  id: NonNegativeInteger,
  position: Point,
  /** 最终分值；正常新无尽同时把它用于逻辑长度增长，并用于死亡残骸尺寸。 */
  value: NonNegativeFinite,
  /**
   * 原始配置长度增量；正常新无尽的 actAsEndless() 不用它增长蛇身，
   * 而是用 value 同时增加逻辑长度和分数。死亡残骸在这里仍保存官方值 3。
   */
  lengthValue: NonNegativeFinite,
  /** 官方 7 种彩点或 20 种 candy 的权威随机帧下标。 */
  variant: NonNegativeInteger,
  /** 同 ID 环境食物每次安全重生翻转，用于区分旧快照与新一代。 */
  generation: Schema.Union([Schema.Literal(0), Schema.Literal(1)]),
  /** 仅星星携带；普通彩点和残骸保持静止。 */
  motion: Schema.optionalKey(StarFoodMotion),
  kind: FoodKind,
});
export type FoodState = typeof FoodState.Type;

/** 正常新无尽地图中唯一允许的道具：`ToolConstant.Magnet` / `10001`。 */
export const MagnetToolState = Schema.Struct({
  id: NonNegativeInteger,
  position: Point,
  /** 半开存在区间的绝对 60 Hz 源帧终点。 */
  expiresAtSourceFrame: NonNegativeInteger,
  directionDegrees: NonNegativeInteger.check(Schema.isLessThan(360)),
  linearFramesRemaining: NonNegativeInteger,
});
export type MagnetToolState = typeof MagnetToolState.Type;

const BoundaryDeathCause = Schema.Struct({ _tag: Schema.Literal("Boundary") });
const SnakeDeathCause = Schema.Struct({
  _tag: Schema.Literal("Snake"),
  killerId: PlayerId,
});
export const DeathCause = Schema.Union([BoundaryDeathCause, SnakeDeathCause]);
export type DeathCause = typeof DeathCause.Type;

export const DeathEvent = Schema.Struct({
  playerId: PlayerId,
  cause: DeathCause,
});
export type DeathEvent = typeof DeathEvent.Type;

/** 食物碰撞时的消费者、绝对源帧、完整食物状态与权威碰撞蛇头坐标。 */
export const FoodConsumedEvent = Schema.Struct({
  playerId: PlayerId,
  sourceFrame: NonNegativeInteger,
  food: FoodState,
  target: Point,
});
export type FoodConsumedEvent = typeof FoodConsumedEvent.Type;

/** 磁铁碰撞时锁定的地图状态与蛇头坐标，用于原版 0.2 秒飞头表现。 */
export const MagnetConsumedEvent = Schema.Struct({
  playerId: PlayerId,
  sourceFrame: NonNegativeInteger,
  magnet: MagnetToolState,
  target: Point,
});
export type MagnetConsumedEvent = typeof MagnetConsumedEvent.Type;

export const TickEvents = Schema.Struct({
  deaths: Schema.Array(DeathEvent),
  consumedFoods: Schema.Array(FoodConsumedEvent),
  /** 可选只用于兼容 v11 JSON 形状；v12 权威服务端始终发送数组。 */
  consumedMagnets: Schema.optionalKey(Schema.Array(MagnetConsumedEvent)),
  respawnedPlayerIds: Schema.Array(PlayerId),
});
export type TickEvents = typeof TickEvents.Type;

export const TickEventBatch = Schema.Struct({
  tick: NonNegativeInteger,
  ...TickEvents.fields,
});
export type TickEventBatch = typeof TickEventBatch.Type;

export const SnakeSnapshot = Schema.Struct({
  id: PlayerId,
  nickname: Nickname,
  body: Schema.Array(Point),
  angle: Schema.Finite,
  /** The server-side steering target; optional for compatibility with older snapshots. */
  targetAngle: Schema.optionalKey(Schema.Finite),
  /** 权威内置皮肤 ID，取值来自官方 `internalSkins` 清单。 */
  skinId: Schema.Int.check(Schema.isGreaterThan(0)),
  /** 原版带迟滞的当前身体缩放档位，不能由当前长度即时反推。 */
  bodyScale: NonNegativeFinite,
  length: NonNegativeFinite,
  score: NonNegativeFinite,
  kills: NonNegativeInteger,
  boosting: Schema.Boolean,
  alive: Schema.Boolean,
  invulnerable: Schema.Boolean,
  /** 缺省兼容 v11；`null` 表示未生效，否则为半开状态区间终点。 */
  magnetUntilSourceFrame: Schema.optionalKey(Schema.NullOr(NonNegativeInteger)),
  respawnAtTick: Schema.NullOr(NonNegativeInteger),
  lastInputSequence: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(-1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  lastInputAppliedTick: NonNegativeInteger,
});
export type SnakeSnapshot = typeof SnakeSnapshot.Type;

export const LeaderboardEntry = Schema.Struct({
  playerId: PlayerId,
  nickname: Nickname,
  length: NonNegativeFinite,
  kills: NonNegativeInteger,
});
export type LeaderboardEntry = typeof LeaderboardEntry.Type;

export const GameSnapshot = Schema.Struct({
  tick: NonNegativeInteger,
  snakes: Schema.Array(SnakeSnapshot),
  foods: Schema.Array(FoodState),
  /** 缺省兼容 v11；v12 快照始终携带权威地图磁铁。 */
  magnets: Schema.optionalKey(Schema.Array(MagnetToolState)),
  leaderboard: Schema.Array(LeaderboardEntry),
});
export type GameSnapshot = typeof GameSnapshot.Type;

export const VoiceParticipant = Schema.Struct({
  playerId: PlayerId,
  nickname: Nickname,
  microphoneEnabled: Schema.Boolean,
});
export type VoiceParticipant = typeof VoiceParticipant.Type;
