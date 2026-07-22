import { defaultGameConfig, type GameConfig } from "../config";

export function gameConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return { ...defaultGameConfig, ambientFoodTarget: 0, ...overrides };
}
