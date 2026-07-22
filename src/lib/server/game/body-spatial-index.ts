import type { Point } from "./geometry";

export interface BodySegment {
  readonly snakeId: string;
  readonly segmentIndex: number;
  readonly start: Point;
  readonly end: Point;
}

export class BodySpatialIndex {
  private readonly columns = new Map<number, Map<number, Array<number>>>();
  private readonly segments: Array<BodySegment> = [];
  private readonly seenAtQuery: Array<number> = [];
  private queryVersion = 0;

  constructor(private readonly cellSize: number) {}

  add(segment: BodySegment): void {
    const order = this.segments.length;
    this.segments.push(segment);
    const minimumX = Math.floor(Math.min(segment.start.x, segment.end.x) / this.cellSize);
    const maximumX = Math.floor(Math.max(segment.start.x, segment.end.x) / this.cellSize);
    const minimumY = Math.floor(Math.min(segment.start.y, segment.end.y) / this.cellSize);
    const maximumY = Math.floor(Math.max(segment.start.y, segment.end.y) / this.cellSize);

    for (let x = minimumX; x <= maximumX; x += 1) {
      let column = this.columns.get(x);
      if (column === undefined) {
        column = new Map();
        this.columns.set(x, column);
      }
      for (let y = minimumY; y <= maximumY; y += 1) {
        const orders = column.get(y);
        if (orders === undefined) column.set(y, [order]);
        else orders.push(order);
      }
    }
  }

  get(order: number): BodySegment | undefined {
    return this.segments[order];
  }

  query(point: Point, radius: number): Array<number> {
    const minimumX = Math.floor((point.x - radius) / this.cellSize);
    const maximumX = Math.floor((point.x + radius) / this.cellSize);
    const minimumY = Math.floor((point.y - radius) / this.cellSize);
    const maximumY = Math.floor((point.y + radius) / this.cellSize);
    this.queryVersion += 1;
    const version = this.queryVersion;
    const result: Array<number> = [];

    for (let x = minimumX; x <= maximumX; x += 1) {
      const column = this.columns.get(x);
      if (column === undefined) continue;
      for (let y = minimumY; y <= maximumY; y += 1) {
        const orders = column.get(y);
        if (orders === undefined) continue;
        for (const order of orders) {
          if (this.seenAtQuery[order] === version) continue;
          this.seenAtQuery[order] = version;
          result.push(order);
        }
      }
    }

    result.sort((left, right) => left - right);
    return result;
  }
}
