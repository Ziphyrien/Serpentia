import { Schema } from "effect";
import { MusicSourceMetadata, MusicSourceResolveRequest } from "../../protocol";

const CorrelationId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

export class RuntimeInitMessage extends Schema.Class<RuntimeInitMessage>("RuntimeInitMessage")({
  _tag: Schema.Literal("init"),
  script: Schema.String,
  metadata: MusicSourceMetadata,
}) {}

export class RuntimeResolveMessage extends Schema.Class<RuntimeResolveMessage>(
  "RuntimeResolveMessage",
)({
  _tag: Schema.Literal("resolve"),
  id: CorrelationId,
  request: MusicSourceResolveRequest,
}) {}

export class RuntimeHttpResponseMessage extends Schema.Class<RuntimeHttpResponseMessage>(
  "RuntimeHttpResponseMessage",
)({
  _tag: Schema.Literal("httpResponse"),
  id: CorrelationId,
  ok: Schema.Boolean,
  value: Schema.Unknown,
}) {}

export class RuntimeShutdownMessage extends Schema.Class<RuntimeShutdownMessage>(
  "RuntimeShutdownMessage",
)({
  _tag: Schema.Literal("shutdown"),
}) {}

export const RuntimeParentMessage = Schema.Union([
  RuntimeInitMessage,
  RuntimeResolveMessage,
  RuntimeHttpResponseMessage,
  RuntimeShutdownMessage,
]);
export type RuntimeParentMessage = typeof RuntimeParentMessage.Type;

export class RuntimeReadyMessage extends Schema.Class<RuntimeReadyMessage>("RuntimeReadyMessage")({
  _tag: Schema.Literal("ready"),
  sources: Schema.Unknown,
}) {}

export class RuntimeResultMessage extends Schema.Class<RuntimeResultMessage>(
  "RuntimeResultMessage",
)({
  _tag: Schema.Literal("result"),
  id: CorrelationId,
  ok: Schema.Boolean,
  value: Schema.Unknown,
}) {}

export class RuntimeHttpRequestMessage extends Schema.Class<RuntimeHttpRequestMessage>(
  "RuntimeHttpRequestMessage",
)({
  _tag: Schema.Literal("httpRequest"),
  id: CorrelationId,
  url: Schema.String,
  options: Schema.Unknown,
}) {}

export class RuntimeHttpCancelMessage extends Schema.Class<RuntimeHttpCancelMessage>(
  "RuntimeHttpCancelMessage",
)({
  _tag: Schema.Literal("httpCancel"),
  id: CorrelationId,
}) {}

export class RuntimeUpdateMessage extends Schema.Class<RuntimeUpdateMessage>(
  "RuntimeUpdateMessage",
)({
  _tag: Schema.Literal("update"),
  value: Schema.Unknown,
}) {}

export class RuntimeLogMessage extends Schema.Class<RuntimeLogMessage>("RuntimeLogMessage")({
  _tag: Schema.Literal("log"),
  level: Schema.Literals(["debug", "info", "warn", "error"]),
  message: Schema.String.check(Schema.isMaxLength(2_048)),
}) {}

export class RuntimeFatalMessage extends Schema.Class<RuntimeFatalMessage>("RuntimeFatalMessage")({
  _tag: Schema.Literal("fatal"),
  message: Schema.String.check(Schema.isMaxLength(2_048)),
}) {}

export const RuntimeChildMessage = Schema.Union([
  RuntimeReadyMessage,
  RuntimeResultMessage,
  RuntimeHttpRequestMessage,
  RuntimeHttpCancelMessage,
  RuntimeUpdateMessage,
  RuntimeLogMessage,
  RuntimeFatalMessage,
]);
export type RuntimeChildMessage = typeof RuntimeChildMessage.Type;
