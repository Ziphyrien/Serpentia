import { Schema } from "effect";
import { BilibiliAudioQuality } from "../../../protocol";

export const BILIBILI_REGULAR_QUALITIES: ReadonlyArray<BilibiliAudioQuality> = [
  "64k",
  "132k",
  "192k",
];
const ApiCode = Schema.Int;
const ApiMessage = Schema.optionalKey(Schema.String);
const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/u;
const Bvid = Schema.String.check(Schema.isPattern(BVID_PATTERN));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const HttpUrl = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));

export function isBilibiliBvid(value: string): boolean {
  return BVID_PATTERN.test(value);
}

export class BilibiliNavResponse extends Schema.Class<BilibiliNavResponse>("BilibiliNavResponse")({
  code: ApiCode,
  message: ApiMessage,
  data: Schema.NullOr(
    Schema.Struct({
      isLogin: Schema.optionalKey(Schema.Boolean),
      wbi_img: Schema.optionalKey(
        Schema.Struct({ img_url: HttpUrl, sub_url: HttpUrl }),
      ),
    }),
  ),
}) {}

export class BilibiliSearchVideo extends Schema.Class<BilibiliSearchVideo>("BilibiliSearchVideo")({
  bvid: Schema.String,
  title: Schema.String,
  pic: Schema.String,
  author: Schema.String,
  duration: Schema.Union([Schema.String, Schema.Int]),
}) {}

export class BilibiliSearchResponse extends Schema.Class<BilibiliSearchResponse>("BilibiliSearchResponse")({
  code: ApiCode,
  message: ApiMessage,
  data: Schema.NullOr(
    Schema.Struct({
      result: Schema.optionalKey(Schema.Array(BilibiliSearchVideo)),
      numResults: Schema.optionalKey(Schema.Int),
      numPages: Schema.optionalKey(Schema.Int),
    }),
  ),
}) {}

export class BilibiliPage extends Schema.Class<BilibiliPage>("BilibiliPage")({
  cid: PositiveInteger,
  page: Schema.optionalKey(PositiveInteger),
  part: Schema.optionalKey(Schema.String),
  duration: Schema.optionalKey(Schema.Int),
}) {}

export class BilibiliPageListResponse extends Schema.Class<BilibiliPageListResponse>("BilibiliPageListResponse")({
  code: ApiCode,
  message: ApiMessage,
  data: Schema.NullOr(Schema.Array(BilibiliPage)),
}) {}

export class BilibiliDashAudio extends Schema.Class<BilibiliDashAudio>("BilibiliDashAudio")({
  id: Schema.Int,
  baseUrl: Schema.optionalKey(HttpUrl),
  base_url: Schema.optionalKey(HttpUrl),
  backupUrl: Schema.optionalKey(Schema.Array(HttpUrl)),
  backup_url: Schema.optionalKey(Schema.Array(HttpUrl)),
  mimeType: Schema.optionalKey(Schema.String),
  mime_type: Schema.optionalKey(Schema.String),
  codecs: Schema.optionalKey(Schema.String),
}) {}

export class BilibiliDurl extends Schema.Class<BilibiliDurl>("BilibiliDurl")({
  url: HttpUrl,
  backup_url: Schema.optionalKey(Schema.Array(HttpUrl)),
  backupUrl: Schema.optionalKey(Schema.Array(HttpUrl)),
}) {}

export class BilibiliPlayUrlResponse extends Schema.Class<BilibiliPlayUrlResponse>("BilibiliPlayUrlResponse")({
  code: ApiCode,
  message: ApiMessage,
  data: Schema.NullOr(
    Schema.Struct({
      dash: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            audio: Schema.optionalKey(Schema.NullOr(Schema.Array(BilibiliDashAudio))),
          }),
        ),
      ),
      durl: Schema.optionalKey(Schema.Array(BilibiliDurl)),
    }),
  ),
}) {}

export class BilibiliTrack extends Schema.Class<BilibiliTrack>("BilibiliTrack")({
  bvid: Bvid,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  artist: Schema.String.check(Schema.isMaxLength(128)),
  pictureUrl: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(512), Schema.isPattern(/^https:\/\/\S+$/iu)),
  ),
  durationSeconds: Schema.NullOr(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })),
  ),
  cid: Schema.NullOr(PositiveInteger),
}) {}

export class BilibiliResolvedAudio extends Schema.Class<BilibiliResolvedAudio>("BilibiliResolvedAudio")({
  bvid: Bvid,
  cid: PositiveInteger,
  quality: BilibiliAudioQuality,
  urls: Schema.Array(
    Schema.String.check(Schema.isMaxLength(4_096), Schema.isPattern(/^https:\/\/\S+$/iu)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  mimeType: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

