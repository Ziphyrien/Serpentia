import { normalGameDegreesToRadians } from "../../game/normal-game-math";

export class DeterministicRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed === 0 ? 0x6d2b79f5 : seed >>> 0;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  between(minimum: number, maximum: number): number {
    return minimum + (maximum - minimum) * this.next();
  }

  /** 对齐旧 `MathUtil.getRandom(min, max)`：半开区间整数。 */
  integer(minimum: number, maximum: number): number {
    return Math.floor(minimum + (maximum - minimum) * this.next());
  }

  /** 对齐正常 Game 的 `MathUtil.getRandomDegree()`：0..359 整数度。 */
  angle(): number {
    return normalGameDegreesToRadians(this.integer(0, 360));
  }
}
