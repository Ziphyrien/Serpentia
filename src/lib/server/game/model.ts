import type { Point } from "../../protocol/state";

export type {
  DeathCause,
  DeathEvent,
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
  body: Array<Point>;
  angle: number;
  targetAngle: number;
  length: number;
  score: number;
  kills: number;
  boosting: boolean;
  boostShed: number;
  alive: boolean;
  respawnAtTick: number | undefined;
  invulnerableUntilTick: number;
  lastInputSequence: number;
}

export interface PlayerInput {
  readonly playerId: string;
  readonly sequence: number;
  readonly angle: number;
  readonly boosting: boolean;
}
