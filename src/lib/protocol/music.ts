import { Schema } from "effect";
import { PlayerId } from "./state";

export const BilibiliAudioQuality = Schema.Literals(["64k", "132k", "192k"]);
export type BilibiliAudioQuality = typeof BilibiliAudioQuality.Type;

const Bvid = Schema.String.check(Schema.isPattern(/^BV[0-9A-Za-z]{10}$/u));
const MusicReference = Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(2_048));
const MusicPosition = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 86_400 }));
const MusicRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const MusicServerTime = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const MusicTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const MusicArtist = Schema.String.check(Schema.isMaxLength(128));
const MusicPictureUrl = Schema.NullOr(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2_048),
    Schema.isPattern(/^https?:\/\/\S+$/iu),
  ),
);
const MusicDuration = Schema.NullOr(
  Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })),
);
const MusicSearchPage = Schema.Int.check(Schema.isGreaterThan(0));

export class MusicBackendStatusResponse extends Schema.Class<MusicBackendStatusResponse>(
  "MusicBackendStatusResponse",
)({
  source: Schema.Literal("bilibili"),
  available: Schema.Boolean,
  qualities: Schema.Array(BilibiliAudioQuality),
}) {}

export class MusicSearchRequest extends Schema.Class<MusicSearchRequest>("MusicSearchRequest")({
  query: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(80),
    Schema.isPattern(/\S/u),
  ),
  page: Schema.optionalKey(MusicSearchPage),
}) {}

export class MusicSearchTrack extends Schema.Class<MusicSearchTrack>("MusicSearchTrack")({
  bvid: Bvid,
  title: MusicTitle,
  artist: MusicArtist,
  durationSeconds: MusicDuration,
  pictureUrl: MusicPictureUrl,
  qualities: Schema.Array(BilibiliAudioQuality).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  reference: MusicReference,
}) {}

export class MusicSearchResponse extends Schema.Class<MusicSearchResponse>("MusicSearchResponse")({
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  tracks: Schema.Array(MusicSearchTrack),
  nextPage: Schema.optionalKey(Schema.NullOr(MusicSearchPage)),
}) {}

export class MusicPlayControl extends Schema.TaggedClass<MusicPlayControl>()("play", {
  reference: MusicReference,
  quality: BilibiliAudioQuality,
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
  bvid: Bvid,
  title: MusicTitle,
  artist: MusicArtist,
  pictureUrl: MusicPictureUrl,
  durationSeconds: MusicDuration,
}) {}

export class MusicResolvedTrack extends Schema.Class<MusicResolvedTrack>("MusicResolvedTrack")({
  ...MusicTrackSummary.fields,
  quality: BilibiliAudioQuality,
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

export const MusicBackendErrorCode = Schema.Literals([
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "RATE_LIMITED",
  "AUTH_REQUIRED",
  "RISK_CONTROLLED",
  "VIDEO_UNAVAILABLE",
  "AUDIO_UNAVAILABLE",
  "UPSTREAM_FAILED",
  "TIMEOUT",
  "BACKEND_UNAVAILABLE",
  "POLICY_DENIED",
]);
export type MusicBackendErrorCode = typeof MusicBackendErrorCode.Type;

export const MusicBackendErrorResponse = Schema.Struct({
  error: MusicBackendErrorCode,
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});
export type MusicBackendErrorResponse = typeof MusicBackendErrorResponse.Type;
