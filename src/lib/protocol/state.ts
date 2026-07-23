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
  Schema.Literal("boost"),
  Schema.Literal("remains"),
]);
export type FoodKind = typeof FoodKind.Type;

export const FoodState = Schema.Struct({
  id: NonNegativeInteger,
  position: Point,
  value: NonNegativeFinite,
  kind: FoodKind,
});
export type FoodState = typeof FoodState.Type;

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

export const TickEvents = Schema.Struct({
  deaths: Schema.Array(DeathEvent),
  consumedFoodIds: Schema.Array(NonNegativeInteger),
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
  radius: NonNegativeFinite,
  length: NonNegativeFinite,
  score: NonNegativeFinite,
  kills: NonNegativeInteger,
  boosting: Schema.Boolean,
  alive: Schema.Boolean,
  invulnerable: Schema.Boolean,
  respawnAtTick: Schema.NullOr(NonNegativeInteger),
  lastInputSequence: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(-1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
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
  leaderboard: Schema.Array(LeaderboardEntry),
});
export type GameSnapshot = typeof GameSnapshot.Type;

export const VoiceParticipant = Schema.Struct({
  playerId: PlayerId,
  nickname: Nickname,
  muted: Schema.Boolean,
});
export type VoiceParticipant = typeof VoiceParticipant.Type;
