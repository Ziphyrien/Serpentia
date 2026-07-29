import type { FoodState, Point } from "$lib/protocol";
import { SNAKE_MOTION } from "$lib/game/snake-motion";
import { STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME } from "$lib/game/food-metrics";

interface TrackedMovingFood {
  readonly generation: FoodState["generation"];
  readonly position: Point;
}

/**
 * 移动星星的纯呈现纠偏。
 *
 * 正常目标每秒前进 `3 × 60` 世界单位；两倍上限中的一半跟随正常运动，另一半
 * 用于逐帧消化快照量化、随机转向和边界转向带来的位置误差。
 */
export class MovingFoodPresentation {
  private readonly tracked = new Map<number, TrackedMovingFood>();

  sample(foods: ReadonlyArray<FoodState>, deltaMs: number): Array<FoodState> {
    const elapsedSeconds = Math.min(0.1, Math.max(0, deltaMs / 1000));
    const maximumDistance =
      STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME * SNAKE_MOTION.sourceFrameRate * elapsedSeconds * 2;
    const seen = new Set<number>();
    const presented: Array<FoodState> = [];

    for (const food of foods) {
      if (food.motion === undefined) {
        presented.push(food);
        continue;
      }

      seen.add(food.id);
      const previous = this.tracked.get(food.id);
      const position =
        previous === undefined || previous.generation !== food.generation
          ? { ...food.position }
          : moveToward(previous.position, food.position, maximumDistance);
      this.tracked.set(food.id, { generation: food.generation, position });
      presented.push({ ...food, position });
    }

    for (const id of this.tracked.keys()) {
      if (!seen.has(id)) this.tracked.delete(id);
    }
    return presented;
  }

  reset(): void {
    this.tracked.clear();
  }
}

function moveToward(from: Point, to: Point, maximumDistance: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0 || distance <= maximumDistance) return { ...to };
  if (maximumDistance <= 0) return { ...from };
  const ratio = maximumDistance / distance;
  return { x: from.x + dx * ratio, y: from.y + dy * ratio };
}
