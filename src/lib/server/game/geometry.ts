import type { Point } from "../../protocol/state";

export type { Point } from "../../protocol/state";

export function distanceSquared(left: Point, right: Point): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}

export function distance(left: Point, right: Point): number {
  return Math.sqrt(distanceSquared(left, right));
}

export function move(point: Point, angle: number, amount: number): Point {
  return {
    x: point.x + Math.cos(angle) * amount,
    y: point.y + Math.sin(angle) * amount,
  };
}

export function pointToSegmentDistanceSquared(point: Point, start: Point, end: Point): number {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (segmentLengthSquared === 0) return distanceSquared(point, start);

  const projection =
    ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / segmentLengthSquared;
  const t = Math.max(0, Math.min(1, projection));
  const closestX = start.x + segmentX * t;
  const closestY = start.y + segmentY * t;
  const dx = point.x - closestX;
  const dy = point.y - closestY;
  return dx * dx + dy * dy;
}

export function interpolate(from: Point, to: Point, ratio: number): Point {
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  };
}
