import { defaultGameConfig, type GameConfig } from "$lib/server/game/config";

/** 测试默认关闭环境食物补充，让场景只包含显式放置的食物。 */
export function gameConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return { ...defaultGameConfig, dotFoodTarget: 0, starFoodTarget: 0, ...overrides };
}
