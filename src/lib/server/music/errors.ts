import { Schema } from "effect";
import {
  MusicBackendErrorCode,
  type MusicBackendErrorCode as MusicBackendErrorCodeType,
} from "../../protocol";

export class MusicBackendError extends Schema.TaggedErrorClass<MusicBackendError>()(
  "MusicBackendError",
  {
    code: MusicBackendErrorCode,
    message: Schema.String,
  },
) {}

export function musicBackendError(
  code: MusicBackendErrorCodeType,
  message: string,
): MusicBackendError {
  return MusicBackendError.make({ code, message });
}

export function isMusicBackendError(value: unknown): value is MusicBackendError {
  return value instanceof MusicBackendError;
}
