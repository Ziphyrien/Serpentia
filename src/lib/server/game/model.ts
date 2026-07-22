import type { Point } from "./geometry";

export type FoodKind = "ambient" | "boost" | "remains";

export interface FoodState {
  readonly id: number;
  readonly position: Point;
  readonly value: number;
  readonly kind: FoodKind;
}

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

export type DeathCause =
  | { readonly _tag: "Boundary" }
  | { readonly _tag: "Snake"; readonly killerId: string };

export interface DeathEvent {
  readonly playerId: string;
  readonly cause: DeathCause;
}

export interface TickEvents {
  readonly deaths: ReadonlyArray<DeathEvent>;
  readonly consumedFoodIds: ReadonlyArray<number>;
  readonly respawnedPlayerIds: ReadonlyArray<string>;
}

export interface SnakeSnapshot {
  readonly id: string;
  readonly nickname: string;
  readonly body: ReadonlyArray<Point>;
  readonly angle: number;
  readonly length: number;
  readonly score: number;
  readonly kills: number;
  readonly boosting: boolean;
  readonly alive: boolean;
  readonly invulnerable: boolean;
  readonly respawnAtTick: number | undefined;
}

export interface GameSnapshot {
  readonly tick: number;
  readonly snakes: ReadonlyArray<SnakeSnapshot>;
  readonly foods: ReadonlyArray<FoodState>;
  readonly leaderboard: ReadonlyArray<{
    readonly playerId: string;
    readonly nickname: string;
    readonly length: number;
    readonly kills: number;
  }>;
}
