import { Schema } from "effect";

export const BilibiliFailureReason = Schema.Literals([
  "INVALID_CONFIG",
  "INVALID_REQUEST",
  "AUTH_REQUIRED",
  "RATE_LIMITED",
  "RISK_CONTROLLED",
  "NOT_FOUND",
  "NO_AUDIO",
  "UPSTREAM_FAILED",
  "PROTOCOL_ERROR",
  "TIMEOUT",
  "POLICY_DENIED",
]);
export type BilibiliFailureReason = typeof BilibiliFailureReason.Type;

export class BilibiliError extends Schema.TaggedErrorClass<BilibiliError>()("BilibiliError", {
  reason: BilibiliFailureReason,
  operation: Schema.String,
  message: Schema.String,
  upstreamCode: Schema.optionalKey(Schema.Int),
  status: Schema.optionalKey(Schema.Int),
}) {}

export function bilibiliError(
  reason: BilibiliFailureReason,
  operation: string,
  message: string,
  details: { readonly upstreamCode?: number; readonly status?: number } = {},
): BilibiliError {
  return BilibiliError.make({ reason, operation, message, ...details });
}

export function isBilibiliError(value: unknown): value is BilibiliError {
  return value instanceof BilibiliError;
}

export function throwForBilibiliCode(code: number, operation: string, message = ""): void {
  if (code === 0) return;
  if (code === -101) {
    throw bilibiliError("AUTH_REQUIRED", operation, "Bilibili Cookie is not logged in", {
      upstreamCode: code,
    });
  }
  if (code === -412) {
    throw bilibiliError("RISK_CONTROLLED", operation, "Bilibili rejected the server request", {
      upstreamCode: code,
    });
  }
  if (code === -404 || code === 62002 || code === 62004 || code === 100100404) {
    throw bilibiliError("NOT_FOUND", operation, "Bilibili video is unavailable", {
      upstreamCode: code,
    });
  }
  if (code === -403 || code === 6002003) {
    throw bilibiliError("POLICY_DENIED", operation, "Bilibili denied access to the resource", {
      upstreamCode: code,
    });
  }
  throw bilibiliError(
    "UPSTREAM_FAILED",
    operation,
    message.trim() || "Bilibili API returned an error",
    { upstreamCode: code },
  );
}
