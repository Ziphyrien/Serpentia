const DIRECTION_DEAD_ZONE = 0.12;
const DIRECTION_DEAD_ZONE_SQUARED = DIRECTION_DEAD_ZONE * DIRECTION_DEAD_ZONE;

export interface JoystickVector {
  readonly x: number;
  readonly y: number;
}

export function directionAngleFromJoystickVector(vector: JoystickVector): number | undefined {
  if (!Number.isFinite(vector.x) || !Number.isFinite(vector.y)) return undefined;
  if (vector.x * vector.x + vector.y * vector.y <= DIRECTION_DEAD_ZONE_SQUARED) {
    return undefined;
  }
  return Math.atan2(-vector.y, vector.x);
}
