export interface Point {
  readonly x: number;
  readonly y: number;
}

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

export function normalizeAngle(angle: number): number {
  const turn = Math.PI * 2;
  const normalized = ((angle + Math.PI) % turn + turn) % turn - Math.PI;
  return normalized === -Math.PI ? Math.PI : normalized;
}

export function turnTowards(current: number, target: number, maximumTurn: number): number {
  const difference = normalizeAngle(target - current);
  if (Math.abs(difference) <= maximumTurn) return normalizeAngle(target);
  return normalizeAngle(current + Math.sign(difference) * maximumTurn);
}

export function pointToSegmentDistanceSquared(point: Point, start: Point, end: Point): number {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (segmentLengthSquared === 0) return distanceSquared(point, start);

  const projection =
    ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) /
    segmentLengthSquared;
  const t = Math.max(0, Math.min(1, projection));
  const closest = { x: start.x + segmentX * t, y: start.y + segmentY * t };
  return distanceSquared(point, closest);
}

export function interpolate(from: Point, to: Point, ratio: number): Point {
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  };
}
