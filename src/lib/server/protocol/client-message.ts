import { Effect, Schema } from "effect";

export class InputMessage extends Schema.TaggedClass<InputMessage>()("input", {
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  angle: Schema.Finite,
  boosting: Schema.Boolean,
}) {}

export class PingMessage extends Schema.TaggedClass<PingMessage>()("ping", {
  nonce: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
}) {}

export class VoiceStateMessage extends Schema.TaggedClass<VoiceStateMessage>()("voice-state", {
  muted: Schema.Boolean,
}) {}

export const ClientMessage = Schema.Union([InputMessage, PingMessage, VoiceStateMessage]);
export type ClientMessage = typeof ClientMessage.Type;

export class ProtocolError extends Schema.TaggedErrorClass<ProtocolError>()("ProtocolError", {
  message: Schema.String,
}) {}

export const decodeClientMessage = Effect.fn("decodeClientMessage")(function* (text: string) {
  const payload = yield* Effect.try({
    try: () => parseJson(text),
    catch: () => new ProtocolError({ message: "Message is not valid JSON" }),
  });

  return yield* Schema.decodeUnknownEffect(ClientMessage)(payload).pipe(
    Effect.mapError((error) => new ProtocolError({ message: error.message })),
  );
});

function parseJson(text: string): unknown {
  return JSON.parse(text);
}
