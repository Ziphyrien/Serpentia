import { Schema } from "effect";
import {
  MusicSourceErrorCode,
  type MusicSourceErrorCode as MusicSourceErrorCodeType,
} from "../../protocol";

export class MusicSourceError extends Schema.TaggedErrorClass<MusicSourceError>()(
  "MusicSourceError",
  {
    code: MusicSourceErrorCode,
    message: Schema.String,
  },
) {}

export function musicSourceError(
  code: MusicSourceErrorCodeType,
  message: string,
): MusicSourceError {
  return MusicSourceError.make({ code, message });
}

export function isMusicSourceError(value: unknown): value is MusicSourceError {
  return value instanceof MusicSourceError;
}
