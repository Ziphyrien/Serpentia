/** 反编译正常 Game `MathUtil.PI` 的实际值。 */
export const NORMAL_GAME_PI = 3.14;
export const NORMAL_GAME_TAU = NORMAL_GAME_PI * 2;

/** 对齐正常 Game `MathUtil.toRad(degrees)`。 */
export function normalGameDegreesToRadians(degrees: number): number {
  return (degrees / 180) * NORMAL_GAME_PI;
}
