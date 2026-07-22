import { Context, Effect, Schema } from "effect";

export interface VoiceSessionOffer {
  readonly playerId: string;
  readonly sessionDescription: string;
}

export interface VoiceSessionAnswer {
  readonly sessionId: string;
  readonly sessionDescription: string;
}

export class VoiceMediaError extends Schema.TaggedErrorClass<VoiceMediaError>()("VoiceMediaError", {
  message: Schema.String,
}) {}

export class VoiceMediaProvider extends Context.Service<
  VoiceMediaProvider,
  {
    readonly createSession: (
      offer: VoiceSessionOffer,
    ) => Effect.Effect<VoiceSessionAnswer, VoiceMediaError>;
  }
>()("VoiceMediaProvider") {}
