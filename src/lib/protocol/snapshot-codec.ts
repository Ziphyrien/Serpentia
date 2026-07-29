import { Schema } from "effect";
import { pack, unpack } from "msgpackr";
import type { SnapshotMessage } from "./game";
import {
  PlayerId,
  type DeathEvent,
  type FoodConsumedEvent,
  type FoodKind,
  type FoodState,
  type LeaderboardEntry,
  MagnetToolState,
  type MagnetConsumedEvent,
  type MagnetToolState as MagnetToolStateType,
  type SnakeSnapshot,
  type TickEventBatch,
} from "./state";
import { GAME_PROTOCOL_VERSION } from "./version";

const FORMAT_VERSION = GAME_PROTOCOL_VERSION;
const STREAM_FULL_FRAME = 0xf0;
const STREAM_DELTA_FRAME_BASE = 0xc0;
const NUMBER_SCALE = 4;
/** 身体缩放在线路上保留三位小数，避免被通用四分之一坐标量化破坏。 */
const BODY_SCALE_NUMBER_SCALE = 1_000;
const QUANTIZATION_TOLERANCE = 1 / (NUMBER_SCALE * 2);
const TAU = Math.PI * 2;
const ANGLE_LEVELS = 65_536;
const MAX_BODY_COORDINATES = 16_384;
const MAX_FOOD_COUNT = 100_000;
const MAX_MAGNET_COUNT = 10_000;
const MAX_EVENT_COUNT = 10_000;

const Nickname = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

const CompactSnakeSchema = Schema.Tuple([PlayerId, Nickname, Schema.Uint8Array, Schema.Uint8Array]);
type CompactSnake = typeof CompactSnakeSchema.Type;

const CompactSnapshotSchema = Schema.Tuple([
  Schema.Literal(FORMAT_VERSION),
  Schema.Uint8Array,
  Schema.Array(CompactSnakeSchema),
  Schema.Uint8Array,
  Schema.Uint8Array,
  Schema.Uint8Array,
  Schema.Array(MagnetToolState),
]);
type CompactSnapshot = typeof CompactSnapshotSchema.Type;

const decodeCompactSnapshot = Schema.decodeUnknownSync(CompactSnapshotSchema);

export function encodeSnapshotMessage(message: SnapshotMessage): Uint8Array {
  const playerIndex = new Map<string, number>();
  const snakes = message.snapshot.snakes.map((snake, index) => {
    playerIndex.set(snake.id, index);
    return encodeSnake(snake);
  });
  const wire: CompactSnapshot = [
    FORMAT_VERSION,
    encodeSnapshotMeta(message.serverTime, message.snapshot.tick),
    snakes,
    encodeFoods(message.snapshot.foods),
    encodeLeaderboards(message.snapshot.leaderboard, message.snapshot.snakes, playerIndex),
    encodeEvents(message.events, playerIndex),
    message.snapshot.magnets ?? [],
  ];
  return pack(wire);
}

export function decodeSnapshotMessage(bytes: Uint8Array): SnapshotMessage {
  if (bytes.length >= 2 && bytes[0] === STREAM_FULL_FRAME) {
    return decodeSnapshotMessage(bytes.subarray(1));
  }
  if (bytes.length > 0 && isStreamDeltaFrame(bytes[0])) {
    throw new Error("Snapshot delta frame requires stream state");
  }
  const unpacked: unknown = unpack(bytes);
  const [
    ,
    metadata,
    compactSnakes,
    compactFoods,
    compactLeaderboard,
    compactEvents,
    compactMagnets,
  ] = decodeCompactSnapshot(unpacked);
  const { serverTime, tick } = decodeSnapshotMeta(metadata);
  const snakes = compactSnakes.map(decodeSnake);
  return {
    v: GAME_PROTOCOL_VERSION,
    _tag: "snapshot",
    serverTime,
    snapshot: {
      tick,
      snakes,
      foods: decodeFoods(compactFoods),
      ...(compactMagnets.length === 0 ? {} : { magnets: compactMagnets }),
      leaderboard: decodeLeaderboards(compactLeaderboard, snakes),
    },
    events: decodeEvents(compactEvents, snakes),
  };
}

export class SnapshotStreamEncoder {
  private previous: SnapshotMessage["snapshot"] | undefined;
  private previousServerTime: number | undefined;
  private previousServerTimeDelta: number | undefined;

  reset(): void {
    this.previous = undefined;
    this.previousServerTime = undefined;
    this.previousServerTimeDelta = undefined;
  }

  keyframe(message: SnapshotMessage): Uint8Array {
    return encodeFullStreamFrame(message);
  }

  encode(message: SnapshotMessage): Uint8Array {
    if (
      this.previous === undefined ||
      this.previousServerTime === undefined ||
      message.snapshot.tick <= this.previous.tick ||
      !sameSnakeIdentities(this.previous, message.snapshot)
    ) {
      const framed = encodeFullStreamFrame(message);
      this.previous = message.snapshot;
      this.previousServerTime = message.serverTime;
      this.previousServerTimeDelta = undefined;
      return framed;
    }

    const serverTimeDelta = message.serverTime - this.previousServerTime;
    const delta = encodeSnapshotDelta(
      message,
      this.previous,
      this.previousServerTime,
      this.previousServerTimeDelta,
    );
    const full = encodeFullStreamFrame(message);
    const encoded = delta.length < full.length ? delta : full;
    this.previous = message.snapshot;
    this.previousServerTime = message.serverTime;
    this.previousServerTimeDelta = encoded === delta ? serverTimeDelta : undefined;
    return encoded;
  }
}

export class SnapshotStreamDecoder {
  private previous: SnapshotMessage["snapshot"] | undefined;
  private previousServerTime: number | undefined;
  private previousServerTimeDelta: number | undefined;

  reset(): void {
    this.previous = undefined;
    this.previousServerTime = undefined;
    this.previousServerTimeDelta = undefined;
  }

  seed(snapshot: SnapshotMessage["snapshot"], serverTime?: number): void {
    this.previous = snapshot;
    this.previousServerTime = serverTime;
    this.previousServerTimeDelta = undefined;
  }

  decode(bytes: Uint8Array): SnapshotMessage {
    if (bytes.length > 0 && isStreamDeltaFrame(bytes[0])) {
      if (this.previous === undefined || this.previousServerTime === undefined) {
        throw new Error("Snapshot delta frame has no base");
      }
      if (usesPredictedServerTime(bytes[0]) && this.previousServerTimeDelta === undefined) {
        throw new Error("Predicted snapshot delta frame has no timing base");
      }
      const previousServerTime = this.previousServerTime;
      const message = decodeSnapshotDelta(
        bytes.subarray(1),
        this.previous,
        previousServerTime,
        bytes[0],
        this.previousServerTimeDelta,
      );
      this.previous = message.snapshot;
      this.previousServerTime = message.serverTime;
      this.previousServerTimeDelta = message.serverTime - previousServerTime;
      return message;
    }
    const message = decodeSnapshotMessage(bytes);
    this.previous = message.snapshot;
    this.previousServerTime = message.serverTime;
    this.previousServerTimeDelta = undefined;
    return message;
  }
}

function encodeStreamDeltaFrame(
  predictedServerTime: boolean,
  implicitTickDelta: boolean,
  tailMask: number,
): number {
  const timing = (predictedServerTime ? 1 : 0) | (implicitTickDelta ? 2 : 0);
  return STREAM_DELTA_FRAME_BASE | (timing << 3) | tailMask;
}

function isStreamDeltaFrame(frame: number): boolean {
  return (frame & 0xe0) === STREAM_DELTA_FRAME_BASE;
}

function usesPredictedServerTime(frame: number): boolean {
  return ((frame >> 3) & 1) !== 0;
}

function usesImplicitTickDelta(frame: number): boolean {
  return ((frame >> 3) & 2) !== 0;
}

function streamTailMask(frame: number): number {
  return frame & 7;
}

function encodeFullStreamFrame(message: SnapshotMessage): Uint8Array {
  const payload = encodeSnapshotMessage(message);
  const framed = new Uint8Array(payload.length + 1);
  framed[0] = STREAM_FULL_FRAME;
  framed.set(payload, 1);
  return framed;
}

function sameSnakeIdentities(
  previous: SnapshotMessage["snapshot"],
  current: SnapshotMessage["snapshot"],
): boolean {
  if (previous.snakes.length !== current.snakes.length) return false;
  for (let index = 0; index < current.snakes.length; index += 1) {
    const left = previous.snakes[index];
    const right = current.snakes[index];
    if (left.id !== right.id || left.nickname !== right.nickname) return false;
  }
  return true;
}

function encodeSnapshotDelta(
  message: SnapshotMessage,
  previous: SnapshotMessage["snapshot"],
  previousServerTime: number,
  previousServerTimeDelta: number | undefined,
): Uint8Array {
  const serverTimeDelta = message.serverTime - previousServerTime;
  const tickDelta = message.snapshot.tick - previous.tick;
  const predicted = previousServerTimeDelta !== undefined;
  const implicitTick = tickDelta === 2;
  const bytes: Array<number> = [0];
  writeSignedVarint(bytes, serverTimeDelta - (previousServerTimeDelta ?? 0));
  if (!implicitTick) writeSignedVarint(bytes, tickDelta);
  const playerIndex = new Map<string, number>();
  for (let index = 0; index < message.snapshot.snakes.length; index += 1) {
    const snake = message.snapshot.snakes[index];
    playerIndex.set(snake.id, index);
    writeSnakeSections(
      bytes,
      encodeSnakeScalarsDelta(snake, previous.snakes[index]),
      encodeBodyDelta(snake.body, previous.snakes[index].body),
    );
  }
  const magnetDelta = encodeMagnetsDelta(
    message.snapshot.magnets ?? [],
    previous.magnets ?? [],
  );
  writeUnsignedVarint(bytes, magnetDelta.length);
  for (const byte of magnetDelta) bytes.push(byte);
  const tailMask = writeTailSections(
    bytes,
    encodeFoodsDelta(message.snapshot.foods, previous.foods),
    encodeLeaderboardsDelta(
      message.snapshot.leaderboard,
      message.snapshot.snakes,
      previous.leaderboard,
      playerIndex,
    ),
    encodeEventsDelta(message.events, playerIndex),
  );
  bytes[0] = encodeStreamDeltaFrame(predicted, implicitTick, tailMask);
  return Uint8Array.from(bytes);
}

function decodeSnapshotDelta(
  bytes: Uint8Array,
  previous: SnapshotMessage["snapshot"],
  previousServerTime: number,
  frame: number,
  previousServerTimeDelta: number | undefined,
): SnapshotMessage {
  let offset = 0;
  const encodedServerTimeDelta = readSignedVarint(bytes, offset);
  offset = encodedServerTimeDelta.offset;
  const serverTimeDelta =
    encodedServerTimeDelta.value +
    (usesPredictedServerTime(frame) ? (previousServerTimeDelta ?? 0) : 0);
  const tickDelta = usesImplicitTickDelta(frame)
    ? { value: 2, offset }
    : readSignedVarint(bytes, offset);
  offset = tickDelta.offset;
  const serverTime = previousServerTime + serverTimeDelta;
  const tick = previous.tick + tickDelta.value;
  if (
    !Number.isSafeInteger(serverTime) ||
    serverTime < 0 ||
    !Number.isSafeInteger(tick) ||
    tick <= previous.tick
  ) {
    throw new Error("Out-of-order snapshot delta");
  }

  const snakes: Array<SnakeSnapshot> = [];
  for (let index = 0; index < previous.snakes.length; index += 1) {
    const sections = readSnakeSections(bytes, offset);
    offset = sections.offset;
    const previousSnake = previous.snakes[index];
    snakes.push(
      snakeFromScalars(
        previousSnake.id,
        previousSnake.nickname,
        decodeBodyDelta(sections.body, previousSnake.body),
        decodeSnakeScalarsDelta(sections.scalars, previousSnake),
      ),
    );
  }

  const magnetSection = readSection(bytes, offset);
  offset = magnetSection.offset;
  const magnets = decodeMagnetsDelta(magnetSection.bytes, previous.magnets ?? []);
  const tail = readTailSections(bytes, offset, streamTailMask(frame));
  offset = tail.offset;
  if (offset !== bytes.length) throw new Error("Trailing snapshot delta data");

  return {
    v: GAME_PROTOCOL_VERSION,
    _tag: "snapshot",
    serverTime,
    snapshot: {
      tick,
      snakes,
      foods: decodeFoodsDelta(tail.foods, previous.foods),
      ...(magnets.length === 0 ? {} : { magnets }),
      leaderboard: decodeLeaderboardsDelta(tail.leaderboard, previous.leaderboard, snakes),
    },
    events: decodeEventsDelta(tail.events, snakes),
  };
}

function writeSnakeSections(target: Array<number>, scalars: Uint8Array, body: Uint8Array): void {
  if (scalars.length < 15 && body.length < 15 && (scalars.length << 4) + body.length !== 0xff) {
    target.push((scalars.length << 4) | body.length);
  } else {
    target.push(0xff);
    writeUnsignedVarint(target, scalars.length);
    writeUnsignedVarint(target, body.length);
  }
  for (const byte of scalars) target.push(byte);
  for (const byte of body) target.push(byte);
}

interface SnakeSectionsResult {
  readonly scalars: Uint8Array;
  readonly body: Uint8Array;
  readonly offset: number;
}

function readSnakeSections(bytes: Uint8Array, offset: number): SnakeSectionsResult {
  if (offset >= bytes.length) throw new Error("Truncated snapshot snake sections");
  const header = bytes[offset];
  offset += 1;
  let scalarLength: number;
  let bodyLength: number;
  if (header === 0xff) {
    const scalars = readUnsignedVarint(bytes, offset);
    offset = scalars.offset;
    const body = readUnsignedVarint(bytes, offset);
    offset = body.offset;
    scalarLength = scalars.value;
    bodyLength = body.value;
  } else {
    scalarLength = header >> 4;
    bodyLength = header & 0x0f;
  }
  if (
    scalarLength === 0 ||
    bodyLength === 0 ||
    scalarLength > 65_536 ||
    bodyLength > 65_536 ||
    offset + scalarLength + bodyLength > bytes.length
  ) {
    throw new Error("Invalid snapshot snake sections");
  }
  return {
    scalars: bytes.subarray(offset, offset + scalarLength),
    body: bytes.subarray(offset + scalarLength, offset + scalarLength + bodyLength),
    offset: offset + scalarLength + bodyLength,
  };
}

function writeTailSections(
  target: Array<number>,
  foods: Uint8Array,
  leaderboard: Uint8Array,
  events: Uint8Array,
): number {
  const mask =
    (foods.length > 0 ? 1 : 0) | (leaderboard.length > 0 ? 2 : 0) | (events.length > 0 ? 4 : 0);
  for (const section of [foods, leaderboard, events]) {
    if (section.length === 0) continue;
    writeUnsignedVarint(target, section.length);
    for (const byte of section) target.push(byte);
  }
  return mask;
}

interface TailSectionsResult {
  readonly foods: Uint8Array;
  readonly leaderboard: Uint8Array;
  readonly events: Uint8Array;
  readonly offset: number;
}

function readTailSections(bytes: Uint8Array, offset: number, mask: number): TailSectionsResult {
  if (mask > 7) throw new Error("Invalid snapshot tail section mask");
  const sections: Array<Uint8Array> = [];
  for (let bit = 0; bit < 3; bit += 1) {
    if ((mask & (1 << bit)) === 0) {
      sections.push(new Uint8Array(0));
      continue;
    }
    const section = readSection(bytes, offset);
    offset = section.offset;
    sections.push(section.bytes);
  }
  return {
    foods: sections[0],
    leaderboard: sections[1],
    events: sections[2],
    offset,
  };
}

interface SectionResult {
  readonly bytes: Uint8Array;
  readonly offset: number;
}

function readSection(bytes: Uint8Array, offset: number): SectionResult {
  const length = readUnsignedVarint(bytes, offset);
  if (length.value > 65_536 || length.offset + length.value > bytes.length) {
    throw new Error("Invalid snapshot delta section");
  }
  return {
    bytes: bytes.subarray(length.offset, length.offset + length.value),
    offset: length.offset + length.value,
  };
}

interface QuantizedPoint {
  readonly x: number;
  readonly y: number;
}

function encodeBodyDelta(
  current: ReadonlyArray<{ x: number; y: number }>,
  previous: ReadonlyArray<{ x: number; y: number }>,
): Uint8Array {
  const currentPoints = current.map((point) => ({
    x: quantizeSigned(point.x),
    y: quantizeSigned(point.y),
  }));
  const previousPoints = previous.map((point) => ({
    x: quantizeSigned(point.x),
    y: quantizeSigned(point.y),
  }));
  let bestShift = 0;
  let bestMatches = 0;
  const maximumShift = Math.min(32, currentPoints.length);
  const countMatches = (shift: number): number => {
    const overlap = Math.min(currentPoints.length - shift, previousPoints.length);
    let matches = 0;
    for (let index = 0; index < overlap; index += 1) {
      const left = currentPoints[index + shift];
      const right = previousPoints[index];
      if (left.x === right.x && left.y === right.y) matches += 1;
    }
    return matches;
  };
  if (maximumShift >= 2) {
    const matches = countMatches(2);
    if (matches >= Math.min(4, Math.min(currentPoints.length - 2, previousPoints.length))) {
      bestShift = 2;
      bestMatches = matches;
    }
  }
  if (bestShift === 0) {
    for (let shift = 1; shift <= maximumShift; shift += 1) {
      if (shift === 2) continue;
      const matches = countMatches(shift);
      if (matches > bestMatches) {
        bestMatches = matches;
        bestShift = shift;
      }
    }
  }
  const overlap = Math.min(Math.max(0, currentPoints.length - bestShift), previousPoints.length);
  if (bestShift === 0 || bestMatches < Math.min(4, overlap)) {
    return encodeFullBodyDelta(current);
  }

  const sameCount = currentPoints.length === previousPoints.length;
  let mode = 2;
  if (bestShift === 2) mode = sameCount ? 1 : 3;
  const delta: Array<number> = [mode];
  if (bestShift !== 2) writeUnsignedVarint(delta, bestShift);
  if (!sameCount || bestShift !== 2) writeUnsignedVarint(delta, currentPoints.length);
  let previousX = previousPoints[0]?.x ?? 0;
  let previousY = previousPoints[0]?.y ?? 0;
  for (let index = 0; index < bestShift; index += 1) {
    const point = currentPoints[index];
    writeSignedVarint(delta, point.x - previousX);
    writeSignedVarint(delta, point.y - previousY);
    previousX = point.x;
    previousY = point.y;
  }

  const corrections: Array<QuantizedPoint & { readonly index: number }> = [];
  for (let index = bestShift; index < currentPoints.length; index += 1) {
    const expected = previousPoints[index - bestShift];
    const actual = currentPoints[index];
    if (expected === undefined || expected.x !== actual.x || expected.y !== actual.y) {
      corrections.push({ index, x: actual.x, y: actual.y });
    }
  }
  for (const correction of corrections) {
    writeUnsignedVarint(delta, correction.index);
    writeSignedVarint(delta, correction.x);
    writeSignedVarint(delta, correction.y);
  }
  const deltaEncoded = Uint8Array.from(delta);
  if (deltaEncoded.length < 1 + current.length * 2) return deltaEncoded;
  const fullEncoded = encodeFullBodyDelta(current);
  return deltaEncoded.length < fullEncoded.length ? deltaEncoded : fullEncoded;
}

function encodeFullBodyDelta(points: ReadonlyArray<{ x: number; y: number }>): Uint8Array {
  const body = encodeBody(points);
  const encoded = new Uint8Array(body.length + 1);
  encoded[0] = 0;
  encoded.set(body, 1);
  return encoded;
}

function decodeBodyDelta(
  bytes: Uint8Array,
  previous: ReadonlyArray<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const mode = readUnsignedVarint(bytes, 0);
  if (mode.value === 0) return decodeBody(bytes.subarray(mode.offset));
  if (mode.value !== 1 && mode.value !== 2 && mode.value !== 3) {
    throw new Error("Invalid snapshot body delta mode");
  }

  let offset = mode.offset;
  const shift = mode.value === 2 ? readUnsignedVarint(bytes, offset) : { value: 2, offset };
  offset = shift.offset;
  const count =
    mode.value === 1 ? { value: previous.length, offset } : readUnsignedVarint(bytes, offset);
  offset = count.offset;
  if (shift.value > count.value || count.value > MAX_BODY_COORDINATES / 2) {
    throw new Error("Invalid snapshot body delta shape");
  }

  const quantized: Array<QuantizedPoint | undefined> = Array.from({ length: count.value });
  const previousPoints = previous.map((point) => ({
    x: quantizeSigned(point.x),
    y: quantizeSigned(point.y),
  }));
  let previousX = previousPoints[0]?.x ?? 0;
  let previousY = previousPoints[0]?.y ?? 0;
  for (let index = 0; index < shift.value; index += 1) {
    const x = readSignedVarint(bytes, offset);
    offset = x.offset;
    const y = readSignedVarint(bytes, offset);
    offset = y.offset;
    const pointX = previousX + x.value;
    const pointY = previousY + y.value;
    quantized[index] = { x: pointX, y: pointY };
    previousX = pointX;
    previousY = pointY;
  }
  for (let index = shift.value; index < count.value; index += 1) {
    const point = previousPoints[index - shift.value];
    if (point !== undefined) quantized[index] = point;
  }

  const corrected = new Set<number>();
  while (offset < bytes.length) {
    if (corrected.size >= count.value) throw new Error("Invalid snapshot body corrections");
    const pointIndex = readUnsignedVarint(bytes, offset);
    offset = pointIndex.offset;
    if (pointIndex.value >= count.value || corrected.has(pointIndex.value)) {
      throw new Error("Invalid snapshot body correction index");
    }
    corrected.add(pointIndex.value);
    const x = readSignedVarint(bytes, offset);
    offset = x.offset;
    const y = readSignedVarint(bytes, offset);
    offset = y.offset;
    quantized[pointIndex.value] = { x: x.value, y: y.value };
  }
  if (offset !== bytes.length) throw new Error("Trailing snapshot body delta data");
  const decoded: Array<{ x: number; y: number }> = [];
  for (const point of quantized) {
    if (point === undefined) throw new Error("Incomplete snapshot body delta");
    decoded.push({ x: dequantize(point.x), y: dequantize(point.y) });
  }
  return decoded;
}

function encodeSnapshotMeta(serverTime: number, tick: number): Uint8Array {
  const bytes: Array<number> = [];
  writeUnsignedVarint(bytes, serverTime);
  writeUnsignedVarint(bytes, tick);
  return Uint8Array.from(bytes);
}

function decodeSnapshotMeta(bytes: Uint8Array): { serverTime: number; tick: number } {
  const serverTime = readUnsignedVarint(bytes, 0);
  const tick = readUnsignedVarint(bytes, serverTime.offset);
  if (tick.offset !== bytes.length) throw new Error("Trailing compact snapshot metadata");
  return { serverTime: serverTime.value, tick: tick.value };
}

function encodeSnake(snake: SnakeSnapshot): CompactSnake {
  return [snake.id, snake.nickname, encodeBody(snake.body), encodeSnakeScalars(snake)];
}

function decodeSnake(wire: CompactSnake): SnakeSnapshot {
  const [id, nickname, bodyBytes, scalarBytes] = wire;
  return snakeFromScalars(id, nickname, decodeBody(bodyBytes), decodeSnakeScalars(scalarBytes));
}

function snakeFromScalars(
  id: string,
  nickname: string,
  body: ReadonlyArray<{ x: number; y: number }>,
  scalars: DecodedSnakeScalars,
): SnakeSnapshot {
  const snake: SnakeSnapshot = {
    id,
    nickname,
    body,
    angle: decodeAngle(scalars.angle),
    skinId: scalars.skinId,
    bodyScale: dequantizeBodyScale(scalars.bodyScale),
    length: dequantize(scalars.length),
    score: dequantize(scalars.score),
    kills: scalars.kills,
    boosting: (scalars.flags & 1) !== 0,
    alive: (scalars.flags & 2) !== 0,
    invulnerable: (scalars.flags & 4) !== 0,
    magnetUntilSourceFrame:
      scalars.magnetUntilSourceFrame < 0 ? null : scalars.magnetUntilSourceFrame,
    respawnAtTick: scalars.respawnAtTick < 0 ? null : scalars.respawnAtTick,
    lastInputSequence: scalars.lastInputSequence,
    lastInputAppliedTick: scalars.lastInputAppliedTick,
  };
  return scalars.targetAngle === null
    ? snake
    : { ...snake, targetAngle: decodeAngle(scalars.targetAngle) };
}

interface DecodedSnakeScalars {
  angle: number;
  targetAngle: number | null;
  skinId: number;
  bodyScale: number;
  length: number;
  score: number;
  kills: number;
  flags: number;
  respawnAtTick: number;
  lastInputSequence: number;
  lastInputAppliedTick: number;
  magnetUntilSourceFrame: number;
}

function snakeStateFlags(snake: SnakeSnapshot): number {
  let flags = 0;
  if (snake.boosting) flags |= 1;
  if (snake.alive) flags |= 2;
  if (snake.invulnerable) flags |= 4;
  return flags;
}

/** Keeps an angle-level difference within half a turn so it varint-encodes compactly. */
function wrapAngleLevels(delta: number): number {
  if (delta > ANGLE_LEVELS / 2) return delta - ANGLE_LEVELS;
  if (delta < -ANGLE_LEVELS / 2) return delta + ANGLE_LEVELS;
  return delta;
}

function encodeSnakeScalars(snake: SnakeSnapshot): Uint8Array {
  const bytes: Array<number> = [];
  const flags = snakeStateFlags(snake) | (snake.respawnAtTick === null ? 0 : 8);
  const angle = encodeAngle(snake.angle);
  writeUnsignedVarint(bytes, angle);
  writeUnsignedVarint(
    bytes,
    encodeTargetAngleCode(
      angle,
      snake.targetAngle === undefined ? null : encodeAngle(snake.targetAngle),
    ),
  );
  writeUnsignedVarint(bytes, quantizeBodyScale(snake.bodyScale));
  writeUnsignedVarint(bytes, snake.skinId);
  writeUnsignedVarint(bytes, quantizeUnsigned(snake.length));
  writeUnsignedVarint(bytes, quantizeUnsigned(snake.score));
  writeUnsignedVarint(bytes, snake.kills * 16 + flags);
  if (snake.respawnAtTick !== null) writeUnsignedVarint(bytes, snake.respawnAtTick);
  writeSignedVarint(bytes, snake.lastInputSequence);
  writeUnsignedVarint(bytes, snake.lastInputAppliedTick);
  writeSignedVarint(bytes, snake.magnetUntilSourceFrame ?? -1);
  return Uint8Array.from(bytes);
}

function decodeSnakeScalars(bytes: Uint8Array): DecodedSnakeScalars {
  let offset = 0;
  const angle = readUnsignedVarint(bytes, offset);
  offset = angle.offset;
  const targetAngleCode = readUnsignedVarint(bytes, offset);
  offset = targetAngleCode.offset;
  const bodyScale = readUnsignedVarint(bytes, offset);
  offset = bodyScale.offset;
  const skinId = readUnsignedVarint(bytes, offset);
  offset = skinId.offset;
  const length = readUnsignedVarint(bytes, offset);
  offset = length.offset;
  const score = readUnsignedVarint(bytes, offset);
  offset = score.offset;
  const killsAndFlags = readUnsignedVarint(bytes, offset);
  offset = killsAndFlags.offset;
  const packedFlags = killsAndFlags.value % 16;
  const respawnAtTick = (packedFlags & 8) !== 0 ? readUnsignedVarint(bytes, offset) : undefined;
  if (respawnAtTick !== undefined) offset = respawnAtTick.offset;
  const lastInputSequence = readSignedVarint(bytes, offset);
  offset = lastInputSequence.offset;
  const lastInputAppliedTick = readUnsignedVarint(bytes, offset);
  offset = lastInputAppliedTick.offset;
  const magnetUntilSourceFrame = readSignedVarint(bytes, offset);
  if (magnetUntilSourceFrame.offset !== bytes.length)
    throw new Error("Trailing compact snake scalar data");
  return {
    angle: angle.value,
    targetAngle:
      targetAngleCode.value === 0
        ? null
        : (angle.value + zigzagDecode(targetAngleCode.value - 1) + ANGLE_LEVELS) % ANGLE_LEVELS,
    skinId: skinId.value,
    bodyScale: bodyScale.value,
    length: length.value,
    score: score.value,
    kills: Math.floor(killsAndFlags.value / 16),
    flags: packedFlags & 7,
    respawnAtTick: respawnAtTick === undefined ? -1 : respawnAtTick.value,
    lastInputSequence: lastInputSequence.value,
    lastInputAppliedTick: lastInputAppliedTick.value,
    magnetUntilSourceFrame: magnetUntilSourceFrame.value,
  };
}

function scalarValues(snake: SnakeSnapshot): DecodedSnakeScalars {
  return {
    angle: encodeAngle(snake.angle),
    targetAngle: snake.targetAngle === undefined ? null : encodeAngle(snake.targetAngle),
    skinId: snake.skinId,
    bodyScale: quantizeBodyScale(snake.bodyScale),
    length: quantizeUnsigned(snake.length),
    score: quantizeUnsigned(snake.score),
    kills: snake.kills,
    flags: snakeStateFlags(snake),
    respawnAtTick: snake.respawnAtTick === null ? -1 : snake.respawnAtTick,
    lastInputSequence: snake.lastInputSequence,
    lastInputAppliedTick: snake.lastInputAppliedTick,
    magnetUntilSourceFrame: snake.magnetUntilSourceFrame ?? -1,
  };
}

function encodeTargetAngleCode(angle: number, targetAngle: number | null): number {
  if (targetAngle === null) return 0;
  return zigzagEncode(wrapAngleLevels(targetAngle - angle)) + 1;
}

function encodeSnakeScalarsDelta(current: SnakeSnapshot, previous: SnakeSnapshot): Uint8Array {
  const next = scalarValues(current);
  const prior = scalarValues(previous);
  const full = encodeSnakeScalars(current);
  const fullEncoded = new Uint8Array(full.length + 1);
  fullEncoded[0] = 0;
  fullEncoded.set(full, 1);

  let mask = 0;
  if (next.angle !== prior.angle) mask |= 1;
  if (next.targetAngle !== prior.targetAngle) mask |= 2;
  if (next.bodyScale !== prior.bodyScale) mask |= 64;
  if (next.length !== prior.length) mask |= 4;
  if (next.score !== prior.score) mask |= 8;
  if (next.kills !== prior.kills || next.flags !== prior.flags) mask |= 16;
  if (next.respawnAtTick !== prior.respawnAtTick) mask |= 128;
  if (next.lastInputSequence !== prior.lastInputSequence) mask |= 32;
  if (next.lastInputAppliedTick !== prior.lastInputAppliedTick) mask |= 256;
  if (next.skinId !== prior.skinId) mask |= 512;
  if (next.magnetUntilSourceFrame !== prior.magnetUntilSourceFrame) mask |= 1024;

  const delta: Array<number> = [];
  writeUnsignedVarint(delta, mask + 1);
  if ((mask & 1) !== 0) writeSignedVarint(delta, wrapAngleLevels(next.angle - prior.angle));
  if ((mask & 2) !== 0) {
    writeUnsignedVarint(delta, encodeTargetAngleCode(next.angle, next.targetAngle));
  }
  if ((mask & 64) !== 0) writeSignedVarint(delta, next.bodyScale - prior.bodyScale);
  if ((mask & 4) !== 0) writeSignedVarint(delta, next.length - prior.length);
  if ((mask & 8) !== 0) writeSignedVarint(delta, next.score - prior.score);
  if ((mask & 16) !== 0) writeUnsignedVarint(delta, next.kills * 16 + next.flags);
  if ((mask & 128) !== 0) writeSignedVarint(delta, next.respawnAtTick - prior.respawnAtTick);
  if ((mask & 32) !== 0) {
    writeSignedVarint(delta, next.lastInputSequence - prior.lastInputSequence);
  }
  if ((mask & 256) !== 0) {
    writeSignedVarint(delta, next.lastInputAppliedTick - prior.lastInputAppliedTick);
  }
  if ((mask & 512) !== 0) writeUnsignedVarint(delta, next.skinId);
  if ((mask & 1024) !== 0) {
    writeSignedVarint(delta, next.magnetUntilSourceFrame - prior.magnetUntilSourceFrame);
  }
  const deltaEncoded = Uint8Array.from(delta);
  return deltaEncoded.length < fullEncoded.length ? deltaEncoded : fullEncoded;
}

function decodeSnakeScalarsDelta(bytes: Uint8Array, previous: SnakeSnapshot): DecodedSnakeScalars {
  const tag = readUnsignedVarint(bytes, 0);
  if (tag.value === 0) return decodeSnakeScalars(bytes.subarray(tag.offset));
  const mask = tag.value - 1;
  if (mask > 0x7ff) throw new Error("Invalid snapshot scalar delta mask");

  let offset = tag.offset;
  const prior = scalarValues(previous);
  const next: DecodedSnakeScalars = { ...prior };
  if ((mask & 1) !== 0) {
    const angle = readSignedVarint(bytes, offset);
    offset = angle.offset;
    next.angle = (prior.angle + angle.value + ANGLE_LEVELS) % ANGLE_LEVELS;
  }
  if ((mask & 2) !== 0) {
    const target = readUnsignedVarint(bytes, offset);
    offset = target.offset;
    next.targetAngle =
      target.value === 0
        ? null
        : (next.angle + zigzagDecode(target.value - 1) + ANGLE_LEVELS) % ANGLE_LEVELS;
  }
  if ((mask & 64) !== 0) {
    const bodyScale = readSignedVarint(bytes, offset);
    offset = bodyScale.offset;
    next.bodyScale = prior.bodyScale + bodyScale.value;
  }
  if ((mask & 4) !== 0) {
    const length = readSignedVarint(bytes, offset);
    offset = length.offset;
    next.length = prior.length + length.value;
  }
  if ((mask & 8) !== 0) {
    const score = readSignedVarint(bytes, offset);
    offset = score.offset;
    next.score = prior.score + score.value;
  }
  if ((mask & 16) !== 0) {
    const killsAndFlags = readUnsignedVarint(bytes, offset);
    offset = killsAndFlags.offset;
    next.kills = Math.floor(killsAndFlags.value / 16);
    next.flags = killsAndFlags.value % 16;
    if (next.flags > 7) throw new Error("Invalid snapshot scalar flags");
  }
  if ((mask & 128) !== 0) {
    const respawn = readSignedVarint(bytes, offset);
    offset = respawn.offset;
    next.respawnAtTick = prior.respawnAtTick + respawn.value;
    if (next.respawnAtTick < -1) throw new Error("Invalid snapshot respawn tick");
  }
  if ((mask & 32) !== 0) {
    const sequence = readSignedVarint(bytes, offset);
    offset = sequence.offset;
    next.lastInputSequence = prior.lastInputSequence + sequence.value;
  }
  if ((mask & 256) !== 0) {
    const appliedTick = readSignedVarint(bytes, offset);
    offset = appliedTick.offset;
    next.lastInputAppliedTick = prior.lastInputAppliedTick + appliedTick.value;
  }
  if ((mask & 512) !== 0) {
    const skinId = readUnsignedVarint(bytes, offset);
    offset = skinId.offset;
    next.skinId = skinId.value;
  }
  if ((mask & 1024) !== 0) {
    const magnetUntilSourceFrame = readSignedVarint(bytes, offset);
    offset = magnetUntilSourceFrame.offset;
    next.magnetUntilSourceFrame = prior.magnetUntilSourceFrame + magnetUntilSourceFrame.value;
  }
  if (offset !== bytes.length) throw new Error("Trailing snapshot scalar delta data");
  if (
    next.bodyScale < 0 ||
    next.skinId <= 0 ||
    next.length < 0 ||
    next.score < 0 ||
    next.kills < 0 ||
    next.lastInputAppliedTick < 0 ||
    next.magnetUntilSourceFrame < -1
  ) {
    throw new Error("Invalid snapshot scalar delta value");
  }
  return next;
}

function encodeBody(points: ReadonlyArray<{ x: number; y: number }>): Uint8Array {
  const bytes: Array<number> = [];
  let previousX = 0;
  let previousY = 0;
  for (let index = 0; index < points.length; index += 1) {
    const x = quantizeSigned(points[index].x);
    const y = quantizeSigned(points[index].y);
    writeSignedVarint(bytes, index === 0 ? x : x - previousX);
    writeSignedVarint(bytes, index === 0 ? y : y - previousY);
    previousX = x;
    previousY = y;
  }
  return Uint8Array.from(bytes);
}

function decodeBody(bytes: Uint8Array): Array<{ x: number; y: number }> {
  let offset = 0;
  const body: Array<{ x: number; y: number }> = [];
  let previousX = 0;
  let previousY = 0;
  while (offset < bytes.length) {
    if (body.length >= MAX_BODY_COORDINATES / 2) {
      throw new Error("Invalid compact snake body length");
    }
    const xResult = readSignedVarint(bytes, offset);
    const yResult = readSignedVarint(bytes, xResult.offset);
    const x = body.length === 0 ? xResult.value : previousX + xResult.value;
    const y = body.length === 0 ? yResult.value : previousY + yResult.value;
    body.push({ x: dequantize(x), y: dequantize(y) });
    previousX = x;
    previousY = y;
    offset = yResult.offset;
  }
  return body;
}

interface VarintResult {
  readonly value: number;
  readonly offset: number;
}

function writeSignedVarint(target: Array<number>, value: number): void {
  writeUnsignedVarint(target, zigzagEncode(value));
}

function zigzagEncode(value: number): number {
  return value < 0 ? -value * 2 - 1 : value * 2;
}

function zigzagDecode(value: number): number {
  return value % 2 === 0 ? value / 2 : -(Math.floor(value / 2) + 1);
}

function writeUnsignedVarint(target: Array<number>, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid compact varint value");
  let remaining = value;
  while (remaining >= 128) {
    target.push((remaining % 128) + 128);
    remaining = Math.floor(remaining / 128);
  }
  target.push(remaining);
}

function readSignedVarint(bytes: Uint8Array, offset: number): VarintResult {
  const result = readUnsignedVarint(bytes, offset);
  return { value: zigzagDecode(result.value), offset: result.offset };
}

function readUnsignedVarint(bytes: Uint8Array, offset: number): VarintResult {
  let value = 0;
  let multiplier = 1;
  let cursor = offset;
  while (cursor < bytes.length && multiplier <= 2 ** 49) {
    const byte = bytes[cursor];
    value += (byte & 0x7f) * multiplier;
    cursor += 1;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value))
        throw new Error("Compact varint exceeds safe integer range");
      return { value, offset: cursor };
    }
    multiplier *= 128;
  }
  throw new Error("Invalid compact varint");
}

function encodeFoods(foods: ReadonlyArray<FoodState>): Uint8Array {
  const bytes: Array<number> = [];
  writeUnsignedVarint(bytes, foods.length);
  let previousId = 0;
  for (const food of foods) {
    writeSignedVarint(bytes, food.id - previousId);
    previousId = food.id;
    writeFoodPayload(bytes, food);
  }
  return Uint8Array.from(bytes);
}

function decodeFoods(bytes: Uint8Array): Array<FoodState> {
  let offset = 0;
  const count = readUnsignedVarint(bytes, offset);
  offset = count.offset;
  if (count.value > MAX_FOOD_COUNT) throw new Error("Invalid compact food count");
  const foods: Array<FoodState> = [];
  let previousId = 0;
  for (let index = 0; index < count.value; index += 1) {
    const idDelta = readSignedVarint(bytes, offset);
    offset = idDelta.offset;
    const id = previousId + idDelta.value;
    if (!Number.isSafeInteger(id) || id < 0) throw new Error("Invalid compact food ID");
    previousId = id;
    const payload = readFoodPayload(bytes, offset, id);
    offset = payload.offset;
    foods.push(payload.food);
  }
  if (offset !== bytes.length) throw new Error("Trailing compact food data");
  return foods;
}

function encodeFoodsDelta(
  foods: ReadonlyArray<FoodState>,
  previous: ReadonlyArray<FoodState>,
): Uint8Array {
  const full = encodeFoods(foods);
  const fullEncoded = new Uint8Array(full.length + 1);
  fullEncoded[0] = 0;
  fullEncoded.set(full, 1);

  const delta: Array<number> = [1];
  writeUnsignedVarint(delta, foods.length);
  const bitmap = new Uint8Array(Math.ceil(foods.length / 8));
  const changed: Array<FoodState> = [];
  for (let index = 0; index < foods.length; index += 1) {
    const food = foods[index];
    const prior = previous[index];
    if (prior === undefined || !sameFood(prior, food)) {
      bitmap[index >> 3] |= 1 << (index & 7);
      changed.push(food);
    }
  }
  if (foods.length === previous.length && changed.length === 0) return new Uint8Array(0);
  for (const byte of bitmap) delta.push(byte);
  for (const food of changed) writeFoodRecord(delta, food);
  const deltaEncoded = Uint8Array.from(delta);
  return deltaEncoded.length < fullEncoded.length ? deltaEncoded : fullEncoded;
}

function decodeFoodsDelta(bytes: Uint8Array, previous: ReadonlyArray<FoodState>): Array<FoodState> {
  if (bytes.length === 0) {
    return previous.map((food) => ({ ...food, position: { ...food.position } }));
  }
  const mode = readUnsignedVarint(bytes, 0);
  if (mode.value === 0) return decodeFoods(bytes.subarray(mode.offset));
  if (mode.value !== 1) throw new Error("Invalid compact food delta mode");

  let offset = mode.offset;
  const count = readUnsignedVarint(bytes, offset);
  offset = count.offset;
  if (count.value > MAX_FOOD_COUNT) throw new Error("Invalid compact food delta count");
  const bitmapLength = Math.ceil(count.value / 8);
  if (offset + bitmapLength > bytes.length) throw new Error("Truncated compact food bitmap");
  const bitmap = bytes.subarray(offset, offset + bitmapLength);
  offset += bitmapLength;
  const foods: Array<FoodState> = [];
  for (let index = 0; index < count.value; index += 1) {
    const changed = (bitmap[index >> 3] & (1 << (index & 7))) !== 0;
    if (!changed) {
      const prior = previous[index];
      if (prior === undefined) throw new Error("Missing unchanged compact food");
      foods.push({ ...prior, position: { ...prior.position } });
      continue;
    }
    const decoded = readFoodRecord(bytes, offset);
    offset = decoded.offset;
    foods.push(decoded.food);
  }
  if (offset !== bytes.length) throw new Error("Trailing compact food delta data");
  return foods;
}

function sameFood(left: FoodState, right: FoodState): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    quantizeUnsigned(left.value) === quantizeUnsigned(right.value) &&
    quantizeUnsigned(left.lengthValue) === quantizeUnsigned(right.lengthValue) &&
    left.variant === right.variant &&
    left.generation === right.generation &&
    sameStarFoodMotion(left.motion, right.motion) &&
    quantizeSigned(left.position.x) === quantizeSigned(right.position.x) &&
    quantizeSigned(left.position.y) === quantizeSigned(right.position.y)
  );
}

function sameStarFoodMotion(left: FoodState["motion"], right: FoodState["motion"]): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.directionDegrees === right.directionDegrees &&
    left.linearFramesRemaining === right.linearFramesRemaining
  );
}

function writeFoodRecord(target: Array<number>, food: FoodState): void {
  writeUnsignedVarint(target, food.id);
  writeFoodPayload(target, food);
}

function writeFoodPayload(target: Array<number>, food: FoodState): void {
  writeSignedVarint(target, quantizeSigned(food.position.x));
  writeSignedVarint(target, quantizeSigned(food.position.y));
  writeUnsignedVarint(
    target,
    quantizeUnsigned(food.value) * FOOD_KIND_BASE + encodeFoodKind(food.kind),
  );
  writeUnsignedVarint(target, quantizeUnsigned(food.lengthValue));
  const motionFlag = food.motion === undefined ? 0 : 1;
  writeUnsignedVarint(target, food.variant * 4 + food.generation * 2 + motionFlag);
  if (food.motion !== undefined) {
    writeUnsignedVarint(target, food.motion.directionDegrees);
    writeUnsignedVarint(target, food.motion.linearFramesRemaining);
  }
}

function readFoodRecord(bytes: Uint8Array, offset: number): { food: FoodState; offset: number } {
  const id = readUnsignedVarint(bytes, offset);
  return readFoodPayload(bytes, id.offset, id.value);
}

function readFoodPayload(
  bytes: Uint8Array,
  offset: number,
  id: number,
): { food: FoodState; offset: number } {
  const x = readSignedVarint(bytes, offset);
  const y = readSignedVarint(bytes, x.offset);
  const valueAndKind = readUnsignedVarint(bytes, y.offset);
  const lengthValue = readUnsignedVarint(bytes, valueAndKind.offset);
  const variantAndFlags = readUnsignedVarint(bytes, lengthValue.offset);
  const hasMotion = variantAndFlags.value % 2 === 1;
  const generation = Math.floor(variantAndFlags.value / 2) % 2 === 0 ? 0 : 1;
  const variant = Math.floor(variantAndFlags.value / 4);
  const directionDegrees = hasMotion
    ? readUnsignedVarint(bytes, variantAndFlags.offset)
    : undefined;
  if (directionDegrees !== undefined && directionDegrees.value >= 360) {
    throw new Error("Invalid compact star direction");
  }
  const linearFramesRemaining =
    directionDegrees === undefined ? undefined : readUnsignedVarint(bytes, directionDegrees.offset);
  const finalOffset = linearFramesRemaining?.offset ?? variantAndFlags.offset;
  return {
    food: {
      id,
      position: { x: dequantize(x.value), y: dequantize(y.value) },
      value: dequantize(Math.floor(valueAndKind.value / FOOD_KIND_BASE)),
      lengthValue: dequantize(lengthValue.value),
      variant,
      generation,
      ...(directionDegrees === undefined || linearFramesRemaining === undefined
        ? {}
        : {
            motion: {
              directionDegrees: directionDegrees.value,
              linearFramesRemaining: linearFramesRemaining.value,
            },
          }),
      kind: decodeFoodKind(valueAndKind.value % FOOD_KIND_BASE),
    },
    offset: finalOffset,
  };
}

function encodeLeaderboards(
  entries: ReadonlyArray<LeaderboardEntry>,
  snakes: ReadonlyArray<SnakeSnapshot>,
  playerIndex: ReadonlyMap<string, number>,
): Uint8Array {
  const bytes: Array<number> = [];
  writeUnsignedVarint(bytes, entries.length);
  for (const entry of entries) {
    const index = requirePlayerIndex(entry.playerId, playerIndex);
    const snake = snakes[index];
    if (
      snake.nickname !== entry.nickname ||
      Math.abs(snake.length - entry.length) > QUANTIZATION_TOLERANCE ||
      snake.kills !== entry.kills
    ) {
      throw new Error("Leaderboard diverged from snake state");
    }
    writeUnsignedVarint(bytes, index);
  }
  return Uint8Array.from(bytes);
}

function decodeLeaderboards(
  bytes: Uint8Array,
  snakes: ReadonlyArray<SnakeSnapshot>,
): Array<LeaderboardEntry> {
  let offset = 0;
  const count = readUnsignedVarint(bytes, offset);
  offset = count.offset;
  if (count.value > snakes.length) throw new Error("Invalid compact leaderboard count");
  const entries: Array<LeaderboardEntry> = [];
  for (let index = 0; index < count.value; index += 1) {
    const player = readUnsignedVarint(bytes, offset);
    offset = player.offset;
    entries.push(toLeaderboardEntry(requireSnake(player.value, snakes)));
  }
  if (offset !== bytes.length) throw new Error("Trailing compact leaderboard data");
  return entries;
}

function encodeLeaderboardsDelta(
  entries: ReadonlyArray<LeaderboardEntry>,
  snakes: ReadonlyArray<SnakeSnapshot>,
  previous: ReadonlyArray<LeaderboardEntry>,
  playerIndex: ReadonlyMap<string, number>,
): Uint8Array {
  const sameOrder =
    entries.length === previous.length &&
    entries.every((entry, index) => entry.playerId === previous[index]?.playerId);
  if (sameOrder) return new Uint8Array(0);

  const full = encodeLeaderboards(entries, snakes, playerIndex);
  const encoded = new Uint8Array(full.length + 1);
  encoded.set(full, 1);
  return encoded;
}

function decodeLeaderboardsDelta(
  bytes: Uint8Array,
  previous: ReadonlyArray<LeaderboardEntry>,
  snakes: ReadonlyArray<SnakeSnapshot>,
): Array<LeaderboardEntry> {
  if (bytes.length === 0) return deriveLeaderboard(previous, snakes);
  const mode = readUnsignedVarint(bytes, 0);
  if (mode.value === 0) return decodeLeaderboards(bytes.subarray(mode.offset), snakes);
  if (mode.value !== 1) throw new Error("Invalid compact leaderboard delta mode");
  const marker = readUnsignedVarint(bytes, mode.offset);
  if (marker.value === 1) return decodeLeaderboards(bytes.subarray(marker.offset), snakes);
  if (marker.value !== 0 || marker.offset !== bytes.length) {
    throw new Error("Invalid compact leaderboard delta marker");
  }
  return deriveLeaderboard(previous, snakes);
}

function deriveLeaderboard(
  previous: ReadonlyArray<LeaderboardEntry>,
  snakes: ReadonlyArray<SnakeSnapshot>,
): Array<LeaderboardEntry> {
  const indexes = new Map(snakes.map((snake, index) => [snake.id, index]));
  return previous.map((entry) => {
    const index = indexes.get(entry.playerId);
    if (index === undefined) throw new Error("Missing unchanged leaderboard player");
    return toLeaderboardEntry(snakes[index]);
  });
}

function toLeaderboardEntry(snake: SnakeSnapshot): LeaderboardEntry {
  return {
    playerId: snake.id,
    nickname: snake.nickname,
    length: snake.length,
    kills: snake.kills,
  };
}

function encodeEventsDelta(
  events: ReadonlyArray<TickEventBatch>,
  playerIndex: ReadonlyMap<string, number>,
): Uint8Array {
  return events.length === 0 ? new Uint8Array(0) : encodeEvents(events, playerIndex);
}

function encodeEvents(
  events: ReadonlyArray<TickEventBatch>,
  playerIndex: ReadonlyMap<string, number>,
): Uint8Array {
  const bytes: Array<number> = [];
  writeUnsignedVarint(bytes, events.length);
  for (const event of events) {
    writeUnsignedVarint(bytes, event.tick);
    writeUnsignedVarint(bytes, event.deaths.length);
    for (const death of event.deaths) {
      writeUnsignedVarint(bytes, requirePlayerIndex(death.playerId, playerIndex));
      if (death.cause._tag === "Boundary") {
        writeUnsignedVarint(bytes, 0);
      } else {
        writeUnsignedVarint(bytes, 1);
        writeUnsignedVarint(bytes, requirePlayerIndex(death.cause.killerId, playerIndex));
      }
    }
    writeUnsignedVarint(bytes, event.consumedFoods.length);
    for (const consumed of event.consumedFoods) {
      writeUnsignedVarint(bytes, requirePlayerIndex(consumed.playerId, playerIndex));
      writeUnsignedVarint(bytes, consumed.sourceFrame);
      writeFoodRecord(bytes, consumed.food);
      writeSignedVarint(bytes, quantizeSigned(consumed.target.x));
      writeSignedVarint(bytes, quantizeSigned(consumed.target.y));
    }
    const consumedMagnets = event.consumedMagnets ?? [];
    writeUnsignedVarint(bytes, consumedMagnets.length);
    for (const consumed of consumedMagnets) {
      writeUnsignedVarint(bytes, requirePlayerIndex(consumed.playerId, playerIndex));
      writeUnsignedVarint(bytes, consumed.sourceFrame);
      writeMagnetRecord(bytes, consumed.magnet);
      writeSignedVarint(bytes, quantizeSigned(consumed.target.x));
      writeSignedVarint(bytes, quantizeSigned(consumed.target.y));
    }
    writeUnsignedVarint(bytes, event.respawnedPlayerIds.length);
    for (const playerId of event.respawnedPlayerIds) {
      writeUnsignedVarint(bytes, requirePlayerIndex(playerId, playerIndex));
    }
  }
  return Uint8Array.from(bytes);
}

function decodeEventsDelta(
  bytes: Uint8Array,
  snakes: ReadonlyArray<SnakeSnapshot>,
): Array<TickEventBatch> {
  return bytes.length === 0 ? [] : decodeEvents(bytes, snakes);
}

function decodeEvents(
  bytes: Uint8Array,
  snakes: ReadonlyArray<SnakeSnapshot>,
): Array<TickEventBatch> {
  let offset = 0;
  const count = readUnsignedVarint(bytes, offset);
  offset = count.offset;
  if (count.value > MAX_EVENT_COUNT) throw new Error("Invalid compact event count");
  const events: Array<TickEventBatch> = [];
  for (let index = 0; index < count.value; index += 1) {
    const tick = readUnsignedVarint(bytes, offset);
    offset = tick.offset;
    const deathCount = readUnsignedVarint(bytes, offset);
    offset = deathCount.offset;
    const deaths: Array<DeathEvent> = [];
    for (let deathIndex = 0; deathIndex < deathCount.value; deathIndex += 1) {
      const victim = readUnsignedVarint(bytes, offset);
      offset = victim.offset;
      const cause = readUnsignedVarint(bytes, offset);
      offset = cause.offset;
      const playerId = requireSnake(victim.value, snakes).id;
      if (cause.value === 0) {
        deaths.push({ playerId, cause: { _tag: "Boundary" } });
      } else if (cause.value === 1) {
        const killer = readUnsignedVarint(bytes, offset);
        offset = killer.offset;
        deaths.push({
          playerId,
          cause: { _tag: "Snake", killerId: requireSnake(killer.value, snakes).id },
        });
      } else {
        throw new Error("Invalid compact death cause");
      }
    }
    const consumedCount = readUnsignedVarint(bytes, offset);
    offset = consumedCount.offset;
    const consumedFoods: Array<FoodConsumedEvent> = [];
    for (let foodIndex = 0; foodIndex < consumedCount.value; foodIndex += 1) {
      const consumer = readUnsignedVarint(bytes, offset);
      const sourceFrame = readUnsignedVarint(bytes, consumer.offset);
      const decodedFood = readFoodRecord(bytes, sourceFrame.offset);
      const targetX = readSignedVarint(bytes, decodedFood.offset);
      const targetY = readSignedVarint(bytes, targetX.offset);
      offset = targetY.offset;
      consumedFoods.push({
        playerId: requireSnake(consumer.value, snakes).id,
        sourceFrame: sourceFrame.value,
        food: decodedFood.food,
        target: { x: dequantize(targetX.value), y: dequantize(targetY.value) },
      });
    }
    const magnetCount = readUnsignedVarint(bytes, offset);
    offset = magnetCount.offset;
    const consumedMagnets: Array<MagnetConsumedEvent> = [];
    for (let magnetIndex = 0; magnetIndex < magnetCount.value; magnetIndex += 1) {
      const consumer = readUnsignedVarint(bytes, offset);
      const sourceFrame = readUnsignedVarint(bytes, consumer.offset);
      const decodedMagnet = readMagnetRecord(bytes, sourceFrame.offset);
      const targetX = readSignedVarint(bytes, decodedMagnet.offset);
      const targetY = readSignedVarint(bytes, targetX.offset);
      offset = targetY.offset;
      consumedMagnets.push({
        playerId: requireSnake(consumer.value, snakes).id,
        sourceFrame: sourceFrame.value,
        magnet: decodedMagnet.magnet,
        target: { x: dequantize(targetX.value), y: dequantize(targetY.value) },
      });
    }
    const respawnCount = readUnsignedVarint(bytes, offset);
    offset = respawnCount.offset;
    const respawnedPlayerIds: Array<string> = [];
    for (let player = 0; player < respawnCount.value; player += 1) {
      const respawned = readUnsignedVarint(bytes, offset);
      offset = respawned.offset;
      respawnedPlayerIds.push(requireSnake(respawned.value, snakes).id);
    }
    events.push({
      tick: tick.value,
      deaths,
      consumedFoods,
      ...(consumedMagnets.length === 0 ? {} : { consumedMagnets }),
      respawnedPlayerIds,
    });
  }
  if (offset !== bytes.length) throw new Error("Trailing compact event data");
  return events;
}

function encodeMagnetsDelta(
  magnets: ReadonlyArray<MagnetToolStateType>,
  previous: ReadonlyArray<MagnetToolStateType>,
): Uint8Array {
  if (
    magnets.length === previous.length &&
    magnets.every((magnet, index) => sameMagnet(magnet, previous[index]))
  ) {
    return new Uint8Array(0);
  }
  const bytes: Array<number> = [];
  writeUnsignedVarint(bytes, magnets.length);
  for (const magnet of magnets) writeMagnetRecord(bytes, magnet);
  return Uint8Array.from(bytes);
}

function decodeMagnetsDelta(
  bytes: Uint8Array,
  previous: ReadonlyArray<MagnetToolStateType>,
): Array<MagnetToolStateType> {
  if (bytes.length === 0) {
    return previous.map((magnet) => ({ ...magnet, position: { ...magnet.position } }));
  }
  let offset = 0;
  const count = readUnsignedVarint(bytes, offset);
  offset = count.offset;
  if (count.value > MAX_MAGNET_COUNT) throw new Error("Invalid compact magnet count");
  const magnets: Array<MagnetToolStateType> = [];
  for (let index = 0; index < count.value; index += 1) {
    const decoded = readMagnetRecord(bytes, offset);
    offset = decoded.offset;
    magnets.push(decoded.magnet);
  }
  if (offset !== bytes.length) throw new Error("Trailing compact magnet data");
  return magnets;
}

function sameMagnet(left: MagnetToolStateType, right: MagnetToolStateType | undefined): boolean {
  return (
    right !== undefined &&
    left.id === right.id &&
    quantizeSigned(left.position.x) === quantizeSigned(right.position.x) &&
    quantizeSigned(left.position.y) === quantizeSigned(right.position.y) &&
    left.expiresAtSourceFrame === right.expiresAtSourceFrame &&
    left.directionDegrees === right.directionDegrees &&
    left.linearFramesRemaining === right.linearFramesRemaining
  );
}

function writeMagnetRecord(target: Array<number>, magnet: MagnetToolStateType): void {
  writeUnsignedVarint(target, magnet.id);
  writeSignedVarint(target, quantizeSigned(magnet.position.x));
  writeSignedVarint(target, quantizeSigned(magnet.position.y));
  writeUnsignedVarint(target, magnet.expiresAtSourceFrame);
  writeUnsignedVarint(target, magnet.directionDegrees);
  writeUnsignedVarint(target, magnet.linearFramesRemaining);
}

function readMagnetRecord(
  bytes: Uint8Array,
  offset: number,
): { magnet: MagnetToolStateType; offset: number } {
  const id = readUnsignedVarint(bytes, offset);
  const x = readSignedVarint(bytes, id.offset);
  const y = readSignedVarint(bytes, x.offset);
  const expiresAtSourceFrame = readUnsignedVarint(bytes, y.offset);
  const directionDegrees = readUnsignedVarint(bytes, expiresAtSourceFrame.offset);
  const linearFramesRemaining = readUnsignedVarint(bytes, directionDegrees.offset);
  if (directionDegrees.value >= 360) throw new Error("Invalid compact magnet direction");
  return {
    magnet: {
      id: id.value,
      position: { x: dequantize(x.value), y: dequantize(y.value) },
      expiresAtSourceFrame: expiresAtSourceFrame.value,
      directionDegrees: directionDegrees.value,
      linearFramesRemaining: linearFramesRemaining.value,
    },
    offset: linearFramesRemaining.offset,
  };
}

function requirePlayerIndex(playerId: string, indexes: ReadonlyMap<string, number>): number {
  const index = indexes.get(playerId);
  if (index === undefined) throw new Error(`Unknown snapshot player: ${playerId}`);
  return index;
}

function requireSnake(index: number, snakes: ReadonlyArray<SnakeSnapshot>): SnakeSnapshot {
  const snake = snakes[index];
  if (snake === undefined) throw new Error(`Invalid snapshot player index: ${index}`);
  return snake;
}

function quantizeSigned(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Cannot encode a non-finite coordinate");
  return Math.round(value * NUMBER_SCALE);
}

function quantizeUnsigned(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Cannot encode an invalid scalar");
  return Math.round(value * NUMBER_SCALE);
}

function quantizeBodyScale(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Cannot encode an invalid body scale");
  return Math.round(value * BODY_SCALE_NUMBER_SCALE);
}

function dequantize(value: number): number {
  return value / NUMBER_SCALE;
}

function dequantizeBodyScale(value: number): number {
  return value / BODY_SCALE_NUMBER_SCALE;
}

function encodeAngle(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Cannot encode a non-finite angle");
  const normalized = ((value % TAU) + TAU) % TAU;
  return Math.round((normalized / TAU) * ANGLE_LEVELS) % ANGLE_LEVELS;
}

function decodeAngle(value: number): number {
  const angle = (value / ANGLE_LEVELS) * TAU;
  return angle > Math.PI ? angle - TAU : angle;
}

/** 食物类型与取值打包在同一个变长整数里，基数需覆盖所有类型。 */
const FOOD_KINDS: ReadonlyArray<FoodKind> = ["ambient", "remains", "boost-remains"];
const FOOD_KIND_BASE = 4;

function encodeFoodKind(kind: FoodKind): number {
  const index = FOOD_KINDS.indexOf(kind);
  if (index === -1) throw new Error(`Invalid food kind: ${kind}`);
  return index;
}

function decodeFoodKind(kind: number): FoodKind {
  const decoded = FOOD_KINDS[kind];
  if (decoded === undefined) throw new Error(`Invalid food kind: ${kind}`);
  return decoded;
}
