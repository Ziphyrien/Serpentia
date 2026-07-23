export interface GameConfig {
  readonly tickRate: number;
  readonly arenaHalfSize: number;
  readonly baseSpeed: number;
  readonly boostSpeed: number;
  readonly turnRate: number;
  readonly initialLength: number;
  readonly minimumLength: number;
  readonly boostMinimumLength: number;
  readonly boostDrainPerSecond: number;
  readonly boostDropValue: number;
  readonly bodyPointSpacing: number;
  readonly baseRadius: number;
  readonly maximumRadius: number;
  readonly radiusGrowth: number;
  readonly foodRadius: number;
  readonly ambientFoodTarget: number;
  readonly ambientFoodValue: number;
  readonly deathDropRatio: number;
  readonly deathFoodSpacing: number;
  readonly respawnDelayTicks: number;
  readonly respawnInvulnerabilityTicks: number;
  readonly spawnAttempts: number;
  readonly spawnClearance: number;
}

export const defaultGameConfig: GameConfig = Object.freeze({
  tickRate: 20,
  arenaHalfSize: 1_000,
  baseSpeed: 132,
  boostSpeed: 218,
  turnRate: 3.8,
  initialLength: 180,
  minimumLength: 72,
  boostMinimumLength: 96,
  boostDrainPerSecond: 15,
  boostDropValue: 3,
  bodyPointSpacing: 8,
  baseRadius: 11,
  maximumRadius: 30,
  radiusGrowth: 2.8,
  foodRadius: 5,
  ambientFoodTarget: 90,
  ambientFoodValue: 2,
  deathDropRatio: 0.72,
  deathFoodSpacing: 18,
  respawnDelayTicks: 30,
  respawnInvulnerabilityTicks: 40,
  spawnAttempts: 32,
  spawnClearance: 180,
});

export function snakeRadius(length: number, config: GameConfig): number {
  const growth = Math.log2(Math.max(1, length / config.initialLength) + 1) * config.radiusGrowth;
  return Math.min(config.maximumRadius, config.baseRadius + growth);
}
