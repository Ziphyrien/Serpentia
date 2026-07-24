import type { FoodState } from "$lib/protocol";

export interface FoodSpeculationFrame {
  readonly foods: ReadonlyArray<FoodState>;
  readonly authoritativeTick: number;
  readonly predictedTick: number;
  readonly head: { readonly x: number; readonly y: number } | undefined;
  readonly predictedHeadAtTick?: (
    tick: number,
  ) => { readonly x: number; readonly y: number } | undefined;
  readonly snakeRadius: number;
  readonly foodRadius: number;
  readonly alive: boolean;
}

interface HiddenFood {
  readonly collisionTick: number;
}

/**
 * Presentation-only food prediction. Hidden food remains authoritative in the
 * snapshot and is restored if the server reaches the predicted collision tick
 * without consuming it.
 */
export class FoodSpeculation {
  private readonly hidden = new Map<number, HiddenFood>();
  private readonly blockedUntilExit = new Set<number>();
  private readonly hiddenIds = new Set<number>();
  private readonly newlyHiddenFoodIds: Array<number> = [];

  update(frame: FoodSpeculationFrame): ReadonlySet<number> {
    this.newlyHiddenFoodIds.length = 0;
    const foodsById = new Map(frame.foods.map((food) => [food.id, food]));
    const collisionDistance = frame.snakeRadius + frame.foodRadius;
    for (const [foodId, prediction] of this.hidden) {
      const food = foodsById.get(foodId);
      if (food === undefined) {
        this.hidden.delete(foodId);
        this.blockedUntilExit.delete(foodId);
        continue;
      }
      const predictedHead = frame.predictedHeadAtTick?.(prediction.collisionTick);
      const trajectoryChanged =
        predictedHead !== undefined && !intersects(predictedHead, food, collisionDistance);
      if (trajectoryChanged || frame.authoritativeTick >= prediction.collisionTick) {
        this.hidden.delete(foodId);
        this.blockedUntilExit.add(foodId);
      }
    }

    if (!frame.alive || frame.head === undefined) {
      this.hidden.clear();
      this.blockedUntilExit.clear();
      return this.refreshHiddenIds();
    }

    const predictedHead = frame.predictedHeadAtTick?.(frame.predictedTick) ?? frame.head;
    for (const food of frame.foods) {
      const visibleIntersection = intersects(frame.head, food, collisionDistance);
      const authoritativeIntersection = intersects(predictedHead, food, collisionDistance);
      if (!visibleIntersection || !authoritativeIntersection) {
        this.blockedUntilExit.delete(food.id);
        continue;
      }
      if (this.hidden.has(food.id) || this.blockedUntilExit.has(food.id)) continue;
      this.hidden.set(food.id, { collisionTick: frame.predictedTick });
      this.newlyHiddenFoodIds.push(food.id);
    }
    return this.refreshHiddenIds();
  }

  takeNewlyHiddenFoodIds(): ReadonlyArray<number> {
    const foodIds = this.newlyHiddenFoodIds.slice();
    this.newlyHiddenFoodIds.length = 0;
    return foodIds;
  }

  confirm(foodId: number): boolean {
    const wasHidden = this.hidden.delete(foodId);
    this.blockedUntilExit.delete(foodId);
    this.hiddenIds.delete(foodId);
    return wasHidden;
  }

  reset(): void {
    this.hidden.clear();
    this.blockedUntilExit.clear();
    this.hiddenIds.clear();
    this.newlyHiddenFoodIds.length = 0;
  }

  private refreshHiddenIds(): ReadonlySet<number> {
    this.hiddenIds.clear();
    for (const foodId of this.hidden.keys()) this.hiddenIds.add(foodId);
    return this.hiddenIds;
  }
}

function intersects(
  head: { readonly x: number; readonly y: number },
  food: FoodState,
  collisionDistance: number,
): boolean {
  return Math.hypot(food.position.x - head.x, food.position.y - head.y) <= collisionDistance;
}
