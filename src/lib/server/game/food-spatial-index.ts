import type { FoodState } from "./model";
import type { Point } from "./geometry";

export class FoodSpatialIndex {
  private readonly cells = new Map<string, Array<number>>();

  constructor(private readonly cellSize: number) {}

  add(food: FoodState): void {
    const key = this.keyFor(food.position);
    const ids = this.cells.get(key);
    if (ids === undefined) this.cells.set(key, [food.id]);
    else ids.push(food.id);
  }

  remove(food: FoodState): void {
    const key = this.keyFor(food.position);
    const ids = this.cells.get(key);
    if (ids === undefined) return;
    const index = ids.indexOf(food.id);
    if (index !== -1) ids.splice(index, 1);
    if (ids.length === 0) this.cells.delete(key);
  }

  clear(): void {
    this.cells.clear();
  }

  query(center: Point, radius: number): Array<number> {
    const minimumX = Math.floor((center.x - radius) / this.cellSize);
    const maximumX = Math.floor((center.x + radius) / this.cellSize);
    const minimumY = Math.floor((center.y - radius) / this.cellSize);
    const maximumY = Math.floor((center.y + radius) / this.cellSize);
    const result: Array<number> = [];

    for (let x = minimumX; x <= maximumX; x += 1) {
      for (let y = minimumY; y <= maximumY; y += 1) {
        const ids = this.cells.get(`${x},${y}`);
        if (ids !== undefined) result.push(...ids);
      }
    }

    result.sort((left, right) => left - right);
    return result;
  }

  private keyFor(point: Point): string {
    return `${Math.floor(point.x / this.cellSize)},${Math.floor(point.y / this.cellSize)}`;
  }
}
