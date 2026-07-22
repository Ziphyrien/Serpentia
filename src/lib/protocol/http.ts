import { Schema } from "effect";
import { BackendDescriptor, IceServer } from "./game";
import { PlayerId } from "./state";

export class SessionRequest extends Schema.Class<SessionRequest>("SessionRequest")({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  nickname: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
}) {}

export const SessionInfo = Schema.Struct({
  authenticated: Schema.Literal(true),
  playerId: PlayerId,
  nickname: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  expiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SessionInfo = typeof SessionInfo.Type;

export const AnonymousSession = Schema.Struct({
  authenticated: Schema.Literal(false),
});
export type AnonymousSession = typeof AnonymousSession.Type;

export const SessionStatus = Schema.Union([SessionInfo, AnonymousSession]);
export type SessionStatus = typeof SessionStatus.Type;

export const SessionErrorCode = Schema.Union([
  Schema.Literal("INVALID_REQUEST"),
  Schema.Literal("INVALID_ACCESS"),
  Schema.Literal("RATE_LIMITED"),
  Schema.Literal("RUNTIME_UNAVAILABLE"),
  Schema.Literal("SERVER_MISCONFIGURED"),
]);
export type SessionErrorCode = typeof SessionErrorCode.Type;

export const SessionErrorResponse = Schema.Struct({ error: SessionErrorCode });
export type SessionErrorResponse = typeof SessionErrorResponse.Type;

export const TurnCredentialsResponse = Schema.Struct({
  iceServers: Schema.Array(IceServer),
  expiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  refreshAfter: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type TurnCredentialsResponse = typeof TurnCredentialsResponse.Type;

export const TurnCredentialsErrorCode = Schema.Union([
  Schema.Literal("UNAUTHORIZED"),
  Schema.Literal("RATE_LIMITED"),
  Schema.Literal("RUNTIME_UNAVAILABLE"),
  Schema.Literal("SERVER_MISCONFIGURED"),
  Schema.Literal("TURN_UNAVAILABLE"),
]);
export type TurnCredentialsErrorCode = typeof TurnCredentialsErrorCode.Type;

export const TurnCredentialsErrorResponse = Schema.Struct({
  error: TurnCredentialsErrorCode,
});
export type TurnCredentialsErrorResponse = typeof TurnCredentialsErrorResponse.Type;

export const GameBootstrapResponse = BackendDescriptor;
export type GameBootstrapResponse = typeof GameBootstrapResponse.Type;
