import { MAGNET } from "../../game/magnet";
import { SNAKE_MOTION, snakeMotionRules, type SnakeMotionRules } from "../../game/snake-motion";

export interface GameConfig {
  readonly tickRate: number;
  readonly arenaHalfSize: number;
  /** 出生逻辑长度，同时是长度下限。 */
  readonly initialLength: number;
  readonly minimumLength: number;
  /** 只封顶身体采样点数、体型和相机；原版逻辑长度与分数仍可继续增长。 */
  readonly maximumLength: number;
  /** 进食判定将蛇头半径与食物半径之和整体放大的倍率。 */
  readonly eatDistanceFactor: number;
  readonly dotFoodValue: number;
  /** 取值达到这个门槛的环境食物按星星处理。 */
  readonly starFoodValue: number;
  readonly dotFoodTarget: number;
  readonly starFoodTarget: number;
  /** 死亡残骸总分 = `pow(分数, 指数) * 系数`，再按份数均分。 */
  readonly remainsScoreExponent: number;
  readonly remainsScoreFactor: number;
  /** 加速掉长时在尾部留下的残骸分值；正常新无尽同时用它恢复长度。 */
  readonly boostRemainsValue: number;
  readonly respawnDelayTicks: number;
  /** 正常 Game 中本机首次出生的 3 秒保护。 */
  readonly initialInvulnerabilityTicks: number;
  /** 正常 Game 中复活时的 3 秒保护。 */
  readonly respawnInvulnerabilityTicks: number;
  readonly spawnAttempts: number;
  readonly spawnClearance: number;
  readonly magnetWaveCount: number;
  readonly magnetExistSourceFrames: number;
  readonly magnetDurationSourceFrames: number;
  readonly magnetExtraEatScope: number;
}

export const defaultGameConfig: GameConfig = Object.freeze({
  tickRate: 20,
  // 地图 4896×4896。
  arenaHalfSize: 2448,
  initialLength: 80,
  minimumLength: 80,
  maximumLength: 100_000,
  eatDistanceFactor: 1.6,
  dotFoodValue: 1,
  starFoodValue: 10,
  dotFoodTarget: 1_000,
  starFoodTarget: 30,
  remainsScoreExponent: 0.8,
  remainsScoreFactor: 2,
  boostRemainsValue: 1,
  respawnDelayTicks: 30,
  initialInvulnerabilityTicks: 60,
  respawnInvulnerabilityTicks: 60,
  spawnAttempts: 32,
  spawnClearance: 240,
  magnetWaveCount: MAGNET.countPerWave,
  magnetExistSourceFrames: MAGNET.existSeconds * SNAKE_MOTION.sourceFrameRate,
  magnetDurationSourceFrames: MAGNET.durationSeconds * SNAKE_MOTION.sourceFrameRate,
  magnetExtraEatScope: MAGNET.extraEatScope,
});

/** 由配置派生共享运动规则；逻辑帧率固定，tick 频率只决定每 tick 的子帧数。 */
export function motionRulesFor(config: GameConfig): SnakeMotionRules {
  return snakeMotionRules({
    tickRate: config.tickRate,
    minimumLength: config.minimumLength,
    maximumLength: config.maximumLength,
  });
}

export const SOURCE_FRAME_RATE = SNAKE_MOTION.sourceFrameRate;
