import { Effect, Schema } from "effect";
import {
  decodeSnapshotMessage,
  encodeSnapshotMessage,
  type SnapshotStreamDecoder,
} from "./snapshot-codec";
import { GameSnapshot, PlayerId, TickEventBatch, VoiceParticipant } from "./state";

export { SnapshotStreamDecoder, SnapshotStreamEncoder } from "./snapshot-codec";

export const GAME_PROTOCOL_VERSION = 1;
export const MAX_CLIENT_MESSAGE_BYTES = 65_536;
export const MAX_INPUT_MESSAGES_PER_SECOND = 40;
export const MAX_VOICE_SIGNALS_PER_SECOND = 64;
export const MAX_TOTAL_MESSAGES_PER_SECOND = 96;

const ProtocolVersion = Schema.Literal(GAME_PROTOCOL_VERSION);
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const InputSequence = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const SessionDescription = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768));
const IceCandidateText = Schema.String.check(Schema.isMaxLength(8_192));
const OptionalIceText = Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)));
const OptionalMLineIndex = Schema.NullOr(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65_535)),
);

export class InputMessage extends Schema.TaggedClass<InputMessage>()("input", {
  v: ProtocolVersion,
  sequence: InputSequence,
  clientTick: NonNegativeInteger,
  angle: Schema.Finite,
  boosting: Schema.Boolean,
}) {}

export class PingMessage extends Schema.TaggedClass<PingMessage>()("ping", {
  v: ProtocolVersion,
  nonce: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
}) {}

export class VoiceStateMessage extends Schema.TaggedClass<VoiceStateMessage>()("voice-state", {
  v: ProtocolVersion,
  muted: Schema.Boolean,
}) {}

export class VoiceOfferSignal extends Schema.TaggedClass<VoiceOfferSignal>()("offer", {
  sdp: SessionDescription,
}) {}

export class VoiceAnswerSignal extends Schema.TaggedClass<VoiceAnswerSignal>()("answer", {
  sdp: SessionDescription,
}) {}

export class VoiceIceSignal extends Schema.TaggedClass<VoiceIceSignal>()("ice", {
  candidate: Schema.NullOr(IceCandidateText),
  sdpMid: OptionalIceText,
  sdpMLineIndex: OptionalMLineIndex,
  usernameFragment: OptionalIceText,
}) {}

export const VoiceSignal = Schema.Union([VoiceOfferSignal, VoiceAnswerSignal, VoiceIceSignal]);
export type VoiceSignal = typeof VoiceSignal.Type;

export class VoiceSignalMessage extends Schema.TaggedClass<VoiceSignalMessage>()("voice-signal", {
  v: ProtocolVersion,
  targetPlayerId: PlayerId,
  signal: VoiceSignal,
}) {}

export const ClientMessage = Schema.Union([
  InputMessage,
  PingMessage,
  VoiceStateMessage,
  VoiceSignalMessage,
]);
export type ClientMessage = typeof ClientMessage.Type;

export class ProtocolError extends Schema.TaggedErrorClass<ProtocolError>()("ProtocolError", {
  message: Schema.String,
}) {}

export const decodeClientMessage = Effect.fn("decodeClientMessage")(function* (text: string) {
  const payload = yield* parseProtocolJson(text);
  return yield* Schema.decodeUnknownEffect(ClientMessage)(payload).pipe(
    Effect.mapError((error) => ProtocolError.make({ message: error.message })),
  );
});

export const RoomLimits = Schema.Struct({
  maxMessageBytes: PositiveInteger,
  maxInputMessagesPerSecond: PositiveInteger,
  maxVoiceSignalsPerSecond: PositiveInteger,
  maxTotalMessagesPerSecond: PositiveInteger,
  maxInputLagTicks: PositiveInteger,
  maxInputLeadTicks: PositiveInteger,
});
export type RoomLimits = typeof RoomLimits.Type;

const IceServerUrl = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^(?:stun|turn|turns):/u),
);

export const IceServer = Schema.Struct({
  urls: Schema.Array(IceServerUrl),
  username: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
  credential: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  ),
});
export type IceServer = typeof IceServer.Type;

export const PublicIceServer = IceServer;
export type PublicIceServer = IceServer;

export const ClientGameRules = Schema.Struct({
  arenaHalfSize: Schema.Finite.check(Schema.isGreaterThan(0)),
  baseSpeed: Schema.Finite.check(Schema.isGreaterThan(0)),
  boostSpeed: Schema.Finite.check(Schema.isGreaterThan(0)),
  turnRate: Schema.Finite.check(Schema.isGreaterThan(0)),
  initialLength: Schema.Finite.check(Schema.isGreaterThan(0)),
  minimumLength: Schema.Finite.check(Schema.isGreaterThan(0)),
  boostMinimumLength: Schema.Finite.check(Schema.isGreaterThan(0)),
  boostDrainPerSecond: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  foodRadius: Schema.Finite.check(Schema.isGreaterThan(0)),
  respawnDelayTicks: NonNegativeInteger,
  respawnInvulnerabilityTicks: NonNegativeInteger,
});
export type ClientGameRules = typeof ClientGameRules.Type;

export const RoomMetadata = Schema.Struct({
  protocolVersion: ProtocolVersion,
  roomId: Schema.Literal("friends"),
  tickRate: PositiveInteger,
  snapshotRate: PositiveInteger,
  reconnectGraceTicks: NonNegativeInteger,
  voiceMode: Schema.Literal("p2p"),
  iceServers: Schema.Array(PublicIceServer),
  rules: ClientGameRules,
  limits: RoomLimits,
});
export type RoomMetadata = typeof RoomMetadata.Type;

export const BackendDescriptor = Schema.Struct({
  ...RoomMetadata.fields,
  sessionPath: Schema.Literal("/api/session"),
  turnCredentialsPath: Schema.Literal("/api/turn-credentials"),
  websocketPath: Schema.Literal("/api/parties/game-room/friends"),
});
export type BackendDescriptor = typeof BackendDescriptor.Type;

export const ServerErrorCode = Schema.Union([
  Schema.Literal("INVALID_MESSAGE"),
  Schema.Literal("MESSAGE_TOO_LARGE"),
  Schema.Literal("RATE_LIMITED"),
  Schema.Literal("STALE_INPUT"),
  Schema.Literal("SESSION_EXPIRED"),
  Schema.Literal("NICKNAME_IN_USE"),
  Schema.Literal("VOICE_NOT_AUTHORIZED"),
  Schema.Literal("VOICE_SELF_TARGET"),
  Schema.Literal("VOICE_TARGET_UNAVAILABLE"),
]);
export type ServerErrorCode = typeof ServerErrorCode.Type;

const ServerTime = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const WelcomeMessage = Schema.Struct({
  v: ProtocolVersion,
  _tag: Schema.Literal("welcome"),
  selfPlayerId: PlayerId,
  resumed: Schema.Boolean,
  sessionExpiresAt: ServerTime,
  serverTime: ServerTime,
  room: RoomMetadata,
  snapshot: GameSnapshot,
  voice: Schema.Array(VoiceParticipant),
});
export type WelcomeMessage = typeof WelcomeMessage.Type;

export const SnapshotMessage = Schema.Struct({
  v: ProtocolVersion,
  _tag: Schema.Literal("snapshot"),
  serverTime: ServerTime,
  snapshot: GameSnapshot,
  events: Schema.Array(TickEventBatch),
});
export type SnapshotMessage = typeof SnapshotMessage.Type;

export const VoiceRosterMessage = Schema.Struct({
  v: ProtocolVersion,
  _tag: Schema.Literal("voice-roster"),
  voice: Schema.Array(VoiceParticipant),
});
export type VoiceRosterMessage = typeof VoiceRosterMessage.Type;

export const VoiceSignalForwardMessage = Schema.Struct({
  v: ProtocolVersion,
  _tag: Schema.Literal("voice-signal"),
  fromPlayerId: PlayerId,
  signal: VoiceSignal,
});
export type VoiceSignalForwardMessage = typeof VoiceSignalForwardMessage.Type;

export const PongMessage = Schema.Struct({
  v: ProtocolVersion,
  _tag: Schema.Literal("pong"),
  nonce: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  serverTime: ServerTime,
});
export type PongMessage = typeof PongMessage.Type;

export const ServerErrorMessage = Schema.Struct({
  v: ProtocolVersion,
  _tag: Schema.Literal("error"),
  code: ServerErrorCode,
  retryable: Schema.Boolean,
});
export type ServerErrorMessage = typeof ServerErrorMessage.Type;

export const ServerMessage = Schema.Union([
  WelcomeMessage,
  SnapshotMessage,
  VoiceRosterMessage,
  VoiceSignalForwardMessage,
  PongMessage,
  ServerErrorMessage,
]);
export type ServerMessage = typeof ServerMessage.Type;

export type ServerWireMessage = string | Uint8Array | ArrayBuffer;

export const decodeServerMessage = Effect.fn("decodeServerMessage")(function* (
  wire: ServerWireMessage,
  snapshotStream?: SnapshotStreamDecoder,
) {
  if (typeof wire !== "string") {
    return yield* Effect.try({
      try: () => {
        const bytes = wire instanceof Uint8Array ? wire : new Uint8Array(wire);
        return snapshotStream?.decode(bytes) ?? decodeSnapshotMessage(bytes);
      },
      catch: () => ProtocolError.make({ message: "Message is not valid compact snapshot data" }),
    });
  }
  const payload = yield* parseProtocolJson(wire);
  return yield* Schema.decodeUnknownEffect(ServerMessage)(payload).pipe(
    Effect.mapError((error) => ProtocolError.make({ message: error.message })),
  );
});

export function encodeServerMessage(message: ServerMessage): ServerWireMessage {
  return message._tag === "snapshot" ? encodeSnapshotMessage(message) : JSON.stringify(message);
}

const parseProtocolJson = Effect.fn("parseProtocolJson")(function* (text: string) {
  return yield* Effect.try({
    try: () => parseJson(text),
    catch: () => ProtocolError.make({ message: "Message is not valid JSON" }),
  });
});

function parseJson(text: string): unknown {
  return JSON.parse(text);
}
