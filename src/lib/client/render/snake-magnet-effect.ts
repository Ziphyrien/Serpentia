export const SNAKE_MAGNET_EFFECT_SOURCE_FRAMES = 20;

interface ScalarKeyframe {
  readonly frame: number;
  readonly value: number;
}

interface PointKeyframe {
  readonly frame: number;
  readonly x: number;
  readonly y: number;
}

interface MagnetLightDefinition {
  readonly textureIndex: number;
  readonly rotationDegrees: number;
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly positions: ReadonlyArray<PointKeyframe>;
  readonly opacities: ReadonlyArray<ScalarKeyframe>;
  readonly scales: ReadonlyArray<ScalarKeyframe>;
}

interface MagnetRingDefinition {
  readonly rotationDegrees: number;
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly opacities: ReadonlyArray<ScalarKeyframe>;
  readonly scales: ReadonlyArray<ScalarKeyframe>;
}

export interface SnakeMagnetSpriteSample {
  readonly x: number;
  readonly y: number;
  readonly alpha: number;
  readonly scale: number;
}

export interface SnakeMagnetParticleSample {
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
  readonly alpha: number;
  readonly size: number;
  readonly tint: number;
  readonly rotation: number;
}

export const SNAKE_MAGNET_LIGHTS: ReadonlyArray<MagnetLightDefinition> = Object.freeze([
  {
    textureIndex: 2,
    rotationDegrees: 60,
    nodeWidth: 77,
    nodeHeight: 32,
    positions: [
      { frame: 0, x: 14.225, y: 32.217 },
      { frame: 1, x: 77.376, y: 120.311 },
      { frame: 20, x: 17.38255, y: 36.6217 },
    ],
    opacities: [
      { frame: 0, value: 0 },
      { frame: 1, value: 0 },
      { frame: 6, value: 255 },
      { frame: 16, value: 255 },
      { frame: 20, value: 51 },
    ],
    scales: [
      { frame: 0, value: 0.5 },
      { frame: 16, value: 1.5 },
      { frame: 20, value: 0.7 },
    ],
  },
  {
    textureIndex: 3,
    rotationDegrees: 80,
    nodeWidth: 55,
    nodeHeight: 63,
    positions: [
      { frame: 0, x: -36.5913, y: 43.2144 },
      { frame: 6, x: -17.406, y: 22.302 },
      { frame: 7, x: -81.357, y: 92.01 },
      { frame: 20, x: -39.78885, y: 46.6998 },
    ],
    opacities: [
      { frame: 0, value: 255 },
      { frame: 1, value: 255 },
      { frame: 6, value: 0 },
      { frame: 7, value: 0 },
      { frame: 12, value: 255 },
      { frame: 20, value: 255 },
    ],
    scales: [
      { frame: 0, value: 1.5 },
      { frame: 1, value: 1.5 },
      { frame: 6, value: 0.5 },
      { frame: 20, value: 1.375 },
    ],
  },
  {
    textureIndex: 1,
    rotationDegrees: 80,
    nodeWidth: 53,
    nodeHeight: 24,
    positions: [
      { frame: 0, x: 2.9695, y: 76.4521 },
      { frame: 11, x: -1.711, y: 24.674 },
      { frame: 12, x: 6.799, y: 118.816 },
      { frame: 20, x: 3.395, y: 81.1592 },
    ],
    opacities: [
      { frame: 0, value: 255 },
      { frame: 6, value: 255 },
      { frame: 11, value: 0 },
      { frame: 12, value: 0 },
      { frame: 17, value: 255 },
      { frame: 20, value: 255 },
    ],
    scales: [
      { frame: 0, value: 1.5 },
      { frame: 6, value: 1.5 },
      { frame: 11, value: 0.2 },
      { frame: 20, value: 0.93125 },
    ],
  },
  {
    textureIndex: 1,
    rotationDegrees: 20,
    nodeWidth: 53,
    nodeHeight: 24,
    positions: [
      { frame: 0, x: 34.97245, y: 13.351 },
      { frame: 3, x: 21.961, y: 8.776 },
      { frame: 4, x: 108.704, y: 39.276 },
      { frame: 20, x: 39.3096, y: 14.876 },
    ],
    opacities: [
      { frame: 0, value: 153 },
      { frame: 3, value: 0 },
      { frame: 4, value: 0 },
      { frame: 9, value: 255 },
      { frame: 19, value: 255 },
      { frame: 20, value: 204 },
    ],
    scales: [
      { frame: 0, value: 1.1 },
      { frame: 3, value: 0.5 },
      { frame: 19, value: 1.5 },
      { frame: 20, value: 1.3 },
    ],
  },
  {
    textureIndex: 1,
    rotationDegrees: 150,
    nodeWidth: 53,
    nodeHeight: 24,
    positions: [
      { frame: 0, x: -48.31, y: 22.27 },
      { frame: 8, x: -7.422, y: 2.664 },
      { frame: 9, x: -109.642, y: 51.679 },
      { frame: 20, x: -53.421, y: 24.72075 },
    ],
    opacities: [
      { frame: 0, value: 255 },
      { frame: 3, value: 255 },
      { frame: 8, value: 0 },
      { frame: 9, value: 0 },
      { frame: 14, value: 255 },
      { frame: 20, value: 255 },
    ],
    scales: [
      { frame: 0, value: 1.5 },
      { frame: 3, value: 1.5 },
      { frame: 8, value: 0.5 },
      { frame: 20, value: 1.25 },
    ],
  },
]);

export const SNAKE_MAGNET_RINGS: ReadonlyArray<MagnetRingDefinition> = Object.freeze([
  {
    rotationDegrees: 20,
    nodeWidth: 125,
    nodeHeight: 126,
    opacities: [
      { frame: 0, value: 0 },
      { frame: 1, value: 0 },
      { frame: 6, value: 50 },
      { frame: 17, value: 0 },
      { frame: 20, value: 0 },
    ],
    scales: [
      { frame: 0, value: 0 },
      { frame: 1, value: 5 },
      { frame: 17, value: 0 },
      { frame: 20, value: 0 },
    ],
  },
  {
    rotationDegrees: 60,
    nodeWidth: 125,
    nodeHeight: 126,
    opacities: [
      { frame: 0, value: 27.272727272727277 },
      { frame: 6, value: 0 },
      { frame: 10, value: 0 },
      { frame: 11, value: 0 },
      { frame: 16, value: 50 },
      { frame: 20, value: 31.818181818181817 },
    ],
    scales: [
      { frame: 0, value: 1.875 },
      { frame: 6, value: 0 },
      { frame: 10, value: 0 },
      { frame: 11, value: 5 },
      { frame: 20, value: 2.1875 },
    ],
  },
]);

export function sampleSnakeMagnetLight(
  index: number,
  elapsedSourceFrames: number,
): SnakeMagnetSpriteSample {
  const definition = SNAKE_MAGNET_LIGHTS[index];
  if (definition === undefined) throw new RangeError("Invalid snake magnet light index");
  const frame = animationFrame(elapsedSourceFrames);
  const position = samplePoint(definition.positions, frame);
  return {
    x: position.x,
    y: position.y,
    alpha: sampleScalar(definition.opacities, frame) / 255,
    scale: sampleScalar(definition.scales, frame),
  };
}

export function sampleSnakeMagnetRing(
  index: number,
  elapsedSourceFrames: number,
): SnakeMagnetSpriteSample {
  const definition = SNAKE_MAGNET_RINGS[index];
  if (definition === undefined) throw new RangeError("Invalid snake magnet ring index");
  const frame = animationFrame(elapsedSourceFrames);
  return {
    x: 2.245,
    y: 1.433,
    alpha: sampleScalar(definition.opacities, frame) / 255,
    scale: sampleScalar(definition.scales, frame),
  };
}

export function sampleSnakeMagnetParticle(
  elapsedSourceFrames: number,
): SnakeMagnetParticleSample {
  const emissionPeriodFrames = 12;
  const lifeFrames = 6;
  const elapsedSinceFirstEmission = elapsedSourceFrames - emissionPeriodFrames;
  const emissionIndex = Math.floor(Math.max(0, elapsedSinceFirstEmission) / emissionPeriodFrames);
  const age = animationFrameInCycle(Math.max(0, elapsedSinceFirstEmission), emissionPeriodFrames);
  const visible = elapsedSinceFirstEmission >= 0 && age < lifeFrames;
  const ratio = Math.min(1, age / lifeFrames);
  const startAlpha = clampColorChannel(
    255 + 255 * signedParticleRandom(emissionIndex, 0x2a),
  );
  const endAlpha = clampColorChannel(
    254 + 255 * signedParticleRandom(emissionIndex, 0x71),
  );
  const startSize = 120 + 20 * signedParticleRandom(emissionIndex, 0xb4);
  return {
    visible,
    x: -32 + signedParticleRandom(emissionIndex, 0x19),
    y: signedParticleRandom(emissionIndex, 0x53),
    alpha: visible ? (startAlpha + (endAlpha - startAlpha) * ratio) / 255 : 0,
    size: startSize + (120 - startSize) * ratio,
    tint: interpolateColor(0xffb400, 0xff9a0d, ratio),
    rotation: (signedParticleRandom(emissionIndex, 0xd7) * ratio * Math.PI) / 180,
  };
}

function animationFrame(elapsedSourceFrames: number): number {
  return animationFrameInCycle(elapsedSourceFrames, SNAKE_MAGNET_EFFECT_SOURCE_FRAMES);
}

function animationFrameInCycle(elapsedSourceFrames: number, cycleFrames: number): number {
  const normalized = elapsedSourceFrames % cycleFrames;
  return normalized < 0 ? normalized + cycleFrames : normalized;
}

function sampleScalar(keyframes: ReadonlyArray<ScalarKeyframe>, frame: number): number {
  const first = keyframes[0];
  if (first === undefined) return 0;
  if (frame <= first.frame) return first.value;
  for (let index = 1; index < keyframes.length; index += 1) {
    const next = keyframes[index];
    if (frame > next.frame) continue;
    const previous = keyframes[index - 1];
    const ratio = (frame - previous.frame) / (next.frame - previous.frame);
    return previous.value + (next.value - previous.value) * ratio;
  }
  return keyframes[keyframes.length - 1]?.value ?? first.value;
}

function samplePoint(
  keyframes: ReadonlyArray<PointKeyframe>,
  frame: number,
): { x: number; y: number } {
  const first = keyframes[0];
  if (first === undefined) return { x: 0, y: 0 };
  if (frame <= first.frame) return { x: first.x, y: first.y };
  for (let index = 1; index < keyframes.length; index += 1) {
    const next = keyframes[index];
    if (frame > next.frame) continue;
    const previous = keyframes[index - 1];
    const ratio = (frame - previous.frame) / (next.frame - previous.frame);
    return {
      x: previous.x + (next.x - previous.x) * ratio,
      y: previous.y + (next.y - previous.y) * ratio,
    };
  }
  const last = keyframes[keyframes.length - 1] ?? first;
  return { x: last.x, y: last.y };
}

function signedParticleRandom(index: number, salt: number): number {
  let value = Math.imul(index + 1, 0x9e3779b1) ^ salt;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0aaad);
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a2d97);
  value ^= value >>> 15;
  return ((value >>> 0) / 0x1_0000_0000) * 2 - 1;
}

function clampColorChannel(value: number): number {
  return Math.min(255, Math.max(0, value));
}

function interpolateColor(from: number, to: number, ratio: number): number {
  const red = Math.round(((from >> 16) & 0xff) * (1 - ratio) + ((to >> 16) & 0xff) * ratio);
  const green = Math.round(((from >> 8) & 0xff) * (1 - ratio) + ((to >> 8) & 0xff) * ratio);
  const blue = Math.round((from & 0xff) * (1 - ratio) + (to & 0xff) * ratio);
  return (red << 16) | (green << 8) | blue;
}
