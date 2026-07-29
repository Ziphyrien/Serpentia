import { motionRulesFor, type GameConfig } from "$lib/server/game/config";
import type { GameSnapshot, SnakeSnapshot } from "$lib/server/game/model";
import { requireCondition } from "./assertions";

export function requireSnake(snapshot: GameSnapshot, playerId: string): SnakeSnapshot {
  const snake = snapshot.snakes.find((candidate) => candidate.id === playerId);
  if (!snake) throw new Error(`Missing snake ${playerId}`);
  return snake;
}

export function approximately(actual: number, expected: number, tolerance = 0.000_001): void {
  requireCondition(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

/** 一个原版源帧前进的世界距离。 */
export function sourceFrameDistance(config: GameConfig, boosting = false): number {
  const motion = motionRulesFor(config);
  const points = boosting ? motion.boostPointsPerFrame : motion.pointsPerFrame;
  return points * motion.pointSpacing;
}

/** 一个 tick 前进的世界距离：子帧数 × 每帧点数 × 点距。 */
export function tickDistance(config: GameConfig, boosting = false): number {
  return motionRulesFor(config).sourceFramesPerTick * sourceFrameDistance(config, boosting);
}

/** 一个 tick 内累计的最大转向角。 */
export function tickTurn(config: GameConfig): number {
  const motion = motionRulesFor(config);
  return motion.sourceFramesPerTick * motion.turnPerFrame;
}
