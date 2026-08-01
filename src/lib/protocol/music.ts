import { Schema } from "effect";
import { PlayerId } from "./state";

export const MusicSourcePlatform = Schema.Literals(["kw", "kg", "tx", "wy", "mg", "local"]);
export type MusicSourcePlatform = typeof MusicSourcePlatform.Type;

export const MusicSourceAction = Schema.Literals(["musicUrl", "lyric", "pic"]);
export type MusicSourceAction = typeof MusicSourceAction.Type;

export const MusicSourceQuality = Schema.Literals(["128k", "320k", "flac", "flac24bit"]);
export type MusicSourceQuality = typeof MusicSourceQuality.Type;

export class MusicSourceCapability extends Schema.Class<MusicSourceCapability>(
  "MusicSourceCapability",
)({
  source: MusicSourcePlatform,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  type: Schema.Literal("music"),
  actions: Schema.Array(MusicSourceAction),
  qualitys: Schema.Array(MusicSourceQuality),
}) {}

export class MusicSourceMetadata extends Schema.Class<MusicSourceMetadata>("MusicSourceMetadata")({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  description: Schema.String.check(Schema.isMaxLength(64)),
  author: Schema.String.check(Schema.isMaxLength(80)),
  homepage: Schema.String.check(Schema.isMaxLength(1_100)),
  version: Schema.String.check(Schema.isMaxLength(64)),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
}) {}

export class MusicSourceEntry extends Schema.Class<MusicSourceEntry>("MusicSourceEntry")({
  metadata: MusicSourceMetadata,
  sources: Schema.Array(MusicSourceCapability),
}) {}

export class MusicSourceUpdateInfo extends Schema.Class<MusicSourceUpdateInfo>(
  "MusicSourceUpdateInfo",
)({
  log: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_027)),
  updateUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_024))),
}) {}

export const MusicSourceStatusResponse = Schema.Struct({
  active: Schema.NullOr(MusicSourceEntry),
  update: Schema.NullOr(MusicSourceUpdateInfo),
});
export type MusicSourceStatusResponse = typeof MusicSourceStatusResponse.Type;

const MusicSearchQuery = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/\S/u),
);
const MusicSearchTotal = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const MusicPictureUrl = Schema.NullOr(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2_048),
    Schema.isPattern(/^https?:\/\/\S+$/iu),
  ),
);
const MusicSearchDuration = Schema.NullOr(
  Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })),
);

export class MusicSearchRequest extends Schema.Class<MusicSearchRequest>("MusicSearchRequest")({
  source: MusicSourcePlatform,
  query: MusicSearchQuery,
}) {}

export class MusicSearchTrack extends Schema.Class<MusicSearchTrack>("MusicSearchTrack")({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  source: MusicSourcePlatform,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  artist: Schema.String.check(Schema.isMaxLength(128)),
  album: Schema.String.check(Schema.isMaxLength(128)),
  durationSeconds: MusicSearchDuration,
  pictureUrl: MusicPictureUrl,
  qualitys: Schema.Array(MusicSourceQuality).check(Schema.isMaxLength(4)),
  musicInfo: Schema.Unknown,
}) {}

export class MusicSearchResponse extends Schema.Class<MusicSearchResponse>("MusicSearchResponse")({
  source: MusicSourcePlatform,
  total: MusicSearchTotal,
  tracks: Schema.Array(MusicSearchTrack).check(Schema.isMaxLength(20)),
}) {}

export class MusicSourceResolveRequest extends Schema.Class<MusicSourceResolveRequest>(
  "MusicSourceResolveRequest",
)({
  source: MusicSourcePlatform,
  action: MusicSourceAction,
  info: Schema.Unknown,
}) {}

export class MusicUrlResolveResult extends Schema.Class<MusicUrlResolveResult>(
  "MusicUrlResolveResult",
)({
  source: MusicSourcePlatform,
  action: Schema.Literal("musicUrl"),
  data: Schema.Struct({
    type: Schema.optionalKey(MusicSourceQuality),
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
  }),
}) {}

export class MusicPictureResolveResult extends Schema.Class<MusicPictureResolveResult>(
  "MusicPictureResolveResult",
)({
  source: MusicSourcePlatform,
  action: Schema.Literal("pic"),
  data: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
}) {}

export class MusicLyricResolveResult extends Schema.Class<MusicLyricResolveResult>(
  "MusicLyricResolveResult",
)({
  source: MusicSourcePlatform,
  action: Schema.Literal("lyric"),
  data: Schema.Struct({
    lyric: Schema.String.check(Schema.isMaxLength(51_200)),
    tlyric: Schema.NullOr(Schema.String.check(Schema.isMaxLength(5_120))),
    rlyric: Schema.NullOr(Schema.String.check(Schema.isMaxLength(5_120))),
    lxlyric: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8_192))),
  }),
}) {}

export const MusicSourceResolveResponse = Schema.Union([
  MusicUrlResolveResult,
  MusicPictureResolveResult,
  MusicLyricResolveResult,
]);
export type MusicSourceResolveResponse = typeof MusicSourceResolveResponse.Type;

const MusicPosition = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 86_400 }));
const MusicRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const MusicServerTime = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const MusicTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const MusicArtist = Schema.String.check(Schema.isMaxLength(128));

export class MusicPlayControl extends Schema.TaggedClass<MusicPlayControl>()("play", {
  source: MusicSourcePlatform,
  info: Schema.Unknown,
  title: MusicTitle,
  artist: MusicArtist,
  pictureUrl: MusicPictureUrl,
}) {}

export class MusicPauseControl extends Schema.TaggedClass<MusicPauseControl>()("pause", {}) {}
export class MusicResumeControl extends Schema.TaggedClass<MusicResumeControl>()("resume", {}) {}
export class MusicStopControl extends Schema.TaggedClass<MusicStopControl>()("stop", {}) {}

export class MusicSeekControl extends Schema.TaggedClass<MusicSeekControl>()("seek", {
  positionSeconds: MusicPosition,
}) {}

export const MusicControl = Schema.Union([
  MusicPlayControl,
  MusicPauseControl,
  MusicResumeControl,
  MusicSeekControl,
  MusicStopControl,
]);
export type MusicControl = typeof MusicControl.Type;

export class MusicControllerInfo extends Schema.Class<MusicControllerInfo>("MusicControllerInfo")({
  playerId: PlayerId,
  nickname: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24)),
}) {}

export class MusicTrackSummary extends Schema.Class<MusicTrackSummary>("MusicTrackSummary")({
  source: MusicSourcePlatform,
  title: MusicTitle,
  artist: MusicArtist,
  pictureUrl: MusicPictureUrl,
}) {}

export class MusicResolvedTrack extends Schema.Class<MusicResolvedTrack>("MusicResolvedTrack")({
  source: MusicSourcePlatform,
  title: MusicTitle,
  artist: MusicArtist,
  pictureUrl: MusicPictureUrl,
  type: Schema.optionalKey(MusicSourceQuality),
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
}) {}

export class MusicStoppedState extends Schema.TaggedClass<MusicStoppedState>()("stopped", {
  revision: MusicRevision,
  changedAt: MusicServerTime,
  changedBy: Schema.NullOr(MusicControllerInfo),
}) {}

export class MusicLoadingState extends Schema.TaggedClass<MusicLoadingState>()("loading", {
  revision: MusicRevision,
  changedAt: MusicServerTime,
  changedBy: MusicControllerInfo,
  track: MusicTrackSummary,
}) {}

export class MusicPlayingState extends Schema.TaggedClass<MusicPlayingState>()("playing", {
  revision: MusicRevision,
  changedAt: MusicServerTime,
  changedBy: MusicControllerInfo,
  track: MusicResolvedTrack,
  positionSeconds: MusicPosition,
  anchorServerTime: MusicServerTime,
}) {}

export class MusicPausedState extends Schema.TaggedClass<MusicPausedState>()("paused", {
  revision: MusicRevision,
  changedAt: MusicServerTime,
  changedBy: MusicControllerInfo,
  track: MusicResolvedTrack,
  positionSeconds: MusicPosition,
}) {}

export const MusicPlaybackState = Schema.Union([
  MusicStoppedState,
  MusicLoadingState,
  MusicPlayingState,
  MusicPausedState,
]);
export type MusicPlaybackState = typeof MusicPlaybackState.Type;

export const MusicSourceErrorCode = Schema.Literals([
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "RATE_LIMITED",
  "SOURCE_UNAVAILABLE",
  "INITIALIZATION_FAILED",
  "RUNTIME_UNAVAILABLE",
  "UPSTREAM_FAILED",
  "TIMEOUT",
  "POLICY_DENIED",
]);
export type MusicSourceErrorCode = typeof MusicSourceErrorCode.Type;

export const MusicSourceErrorResponse = Schema.Struct({
  error: MusicSourceErrorCode,
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});
export type MusicSourceErrorResponse = typeof MusicSourceErrorResponse.Type;
