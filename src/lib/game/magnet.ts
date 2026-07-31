import { MAP_BORDER } from "./arena";
import { normalGameDegreesToRadians } from "./normal-game-math";

export const MAGNET = Object.freeze({
  toolId: 10_001,
  countPerWave: 10,
  appearTimesSeconds: Object.freeze([15, 60, 150]),
  repeatSeconds: 150,
  repeatLengthLimit: 50_000,
  existSeconds: 20,
  durationSeconds: 8,
  toolSize: 70,
  moveDistancePerSourceFrame: 3,
  directionFrameMin: 100,
  directionFrameMaxExclusive: 200,
  extraEatScope: 2.4 * 36,
  pickupFlySeconds: 0.2,
});

export function shouldGenerateMagnetWave(second: number, mainSnakeLength: number): boolean {
  return (
    MAGNET.appearTimesSeconds.some((appearTime) => appearTime === second) ||
    (second > MAGNET.repeatSeconds &&
      second % MAGNET.repeatSeconds === 0 &&
      mainSnakeLength < MAGNET.repeatLengthLimit)
  );
}

export interface MovingMagnetShape {
  readonly position: { readonly x: number; readonly y: number };
  readonly directionDegrees: number;
}

export interface PredictableMagnetShape extends MovingMagnetShape {
  readonly linearFramesRemaining: number;
}

export const MAGNET_PICKUP_SOURCE_FRAME_COUNT = Math.round(MAGNET.pickupFlySeconds * 60);
export const MAGNET_PREDICTION_CONTACT_GUARD = 0.5;

export function magnetBorderDirection(
  magnet: MovingMagnetShape,
  arenaHalfSize: number,
): number | undefined {
  const extent = arenaHalfSize - MAP_BORDER;
  const halfSize = MAGNET.toolSize / 2;
  if (magnet.position.x - halfSize < -extent) return 0;
  if (magnet.position.y + halfSize > extent) return 270;
  if (magnet.position.x + halfSize > extent) return 180;
  if (magnet.position.y - halfSize < -extent) return 90;
  return undefined;
}

export function magnetPositionAfterSourceFrames(
  magnet: MovingMagnetShape,
  sourceFrames: number,
  arenaHalfSize: number,
): { x: number; y: number } {
  const extent = arenaHalfSize - MAP_BORDER;
  let x = magnet.position.x;
  let y = magnet.position.y;
  let directionDegrees = magnet.directionDegrees;
  const boundedFrames = Math.max(0, sourceFrames);
  const wholeFrames = Math.floor(boundedFrames);

  for (let frame = 0; frame < wholeFrames; frame += 1) {
    directionDegrees =
      magnetBorderDirection({ position: { x, y }, directionDegrees }, arenaHalfSize) ??
      directionDegrees;
    const radians = fixedMagnetNumber(normalGameDegreesToRadians(directionDegrees));
    x = confirmMagnetCoordinate(
      fixedMagnetNumber(x + Math.cos(radians) * MAGNET.moveDistancePerSourceFrame),
      extent,
    );
    y = confirmMagnetCoordinate(
      fixedMagnetNumber(y + Math.sin(radians) * MAGNET.moveDistancePerSourceFrame),
      extent,
    );
  }

  const partialFrame = boundedFrames - wholeFrames;
  if (partialFrame > 0) {
    directionDegrees =
      magnetBorderDirection({ position: { x, y }, directionDegrees }, arenaHalfSize) ??
      directionDegrees;
    const radians = fixedMagnetNumber(normalGameDegreesToRadians(directionDegrees));
    x = confirmMagnetCoordinate(
      fixedMagnetNumber(
        x + Math.cos(radians) * MAGNET.moveDistancePerSourceFrame * partialFrame,
      ),
      extent,
    );
    y = confirmMagnetCoordinate(
      fixedMagnetNumber(
        y + Math.sin(radians) * MAGNET.moveDistancePerSourceFrame * partialFrame,
      ),
      extent,
    );
  }

  return { x, y };
}

export function predictMagnetCollisionPosition(
  magnet: PredictableMagnetShape,
  authoritativeSourceFrame: number,
  collisionSourceFrame: number,
  arenaHalfSize: number,
): { x: number; y: number } | undefined {
  if (!Number.isInteger(authoritativeSourceFrame) || !Number.isInteger(collisionSourceFrame)) {
    return undefined;
  }
  const sourceFrames = collisionSourceFrame - authoritativeSourceFrame;
  if (sourceFrames < 0 || sourceFrames >= magnet.linearFramesRemaining) return undefined;
  return magnetPositionAfterSourceFrames(magnet, sourceFrames, arenaHalfSize);
}

function fixedMagnetNumber(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function confirmMagnetCoordinate(value: number, extent: number): number {
  return Math.min(extent, Math.max(-extent, value));
}
