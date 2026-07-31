import { createCipheriv, createHash } from "node:crypto";
import {
  MusicSearchResponse,
  MusicSearchTrack,
  type MusicSearchRequest,
  type MusicSourceQuality,
} from "../../protocol";
import { musicSourceError } from "./errors";
import { MusicOutboundHttp } from "./outbound-http";

const SEARCH_LIMIT = 20;
const REQUEST_TIMEOUT_MILLISECONDS = 12_000;
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36";
const QUALITY_ORDER: ReadonlyArray<MusicSourceQuality> = [
  "128k",
  "320k",
  "flac",
  "flac24bit",
];

type OnlineMusicSource = "kw" | "kg" | "tx" | "wy" | "mg";
type JsonRecord = Record<string, unknown>;

interface SearchPage {
  readonly total: number;
  readonly tracks: Array<MusicSearchTrack>;
}

interface QualityEntry {
  readonly type: MusicSourceQuality;
  readonly size: string | null;
  readonly hash?: string;
}

interface TrackInput {
  readonly source: OnlineMusicSource;
  readonly songId: string | number;
  readonly id?: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly albumId?: string | number;
  readonly durationSeconds: number | null;
  readonly picUrl?: string | null;
  readonly qualitys: ReadonlyArray<QualityEntry>;
  readonly extraMeta?: Readonly<JsonRecord>;
}

/**
 * LX Music-compatible platform search. Request formats and MusicInfo normalization are adapted
 * from LX Music Desktop's musicSdk (Apache-2.0): https://github.com/lyswhut/lx-music-desktop
 * The custom source remains responsible only for resolving the selected track's playable URL.
 */
export class MusicSearchService {
  constructor(private readonly http: MusicOutboundHttp = new MusicOutboundHttp()) {}

  async search(request: MusicSearchRequest, signal?: AbortSignal): Promise<MusicSearchResponse> {
    const query = request.query.trim();
    if (query.length === 0) throw musicSourceError("INVALID_REQUEST", "Search query is empty");

    let page: SearchPage;
    switch (request.source) {
      case "kw":
        page = await searchKuwo(this.http, query, signal);
        break;
      case "kg":
        page = await searchKugou(this.http, query, signal);
        break;
      case "tx":
        page = await searchTencent(this.http, query, signal);
        break;
      case "wy":
        page = await searchNetease(this.http, query, signal);
        break;
      case "mg":
        page = await searchMigu(this.http, query, signal);
        break;
      case "local":
        throw musicSourceError("INVALID_REQUEST", "Local music does not support search");
    }

    return MusicSearchResponse.make({
      source: request.source,
      total: boundedTotal(page.total),
      tracks: page.tracks.slice(0, SEARCH_LIMIT),
    });
  }
}

async function searchKuwo(
  http: MusicOutboundHttp,
  query: string,
  signal?: AbortSignal,
): Promise<SearchPage> {
  const url = new URL("http://search.kuwo.cn/r.s");
  setParams(url, {
    client: "kt",
    all: query,
    pn: "0",
    rn: String(SEARCH_LIMIT),
    uid: "794762570",
    ver: "kwplayer_ar_9.2.2.1",
    vipver: "1",
    show_copyright_off: "1",
    newver: "1",
    ft: "music",
    cluster: "0",
    strategy: "2012",
    encoding: "utf8",
    rformat: "json",
    vermerge: "1",
    mobi: "1",
    issubtitle: "1",
  });
  const body = await requestBody(http, url.toString(), getOptions(), signal);
  const root = requireRecord(body, "Kuwo search returned invalid data");
  const tracks: Array<MusicSearchTrack> = [];

  for (const raw of arrayValue(root.abslist)) {
    const item = recordValue(raw);
    if (item === undefined) continue;
    const songId = stringValue(item.MUSICRID)?.replace(/^MUSIC_/u, "");
    if (!songId) continue;
    const track = makeTrack({
      source: "kw",
      songId,
      title: cleanText(item.SONGNAME, 128),
      artist: cleanText(item.ARTIST, 128),
      album: cleanText(item.ALBUM, 128),
      albumId: scalarValue(item.ALBUMID),
      durationSeconds: durationValue(item.DURATION),
      qualitys: parseKuwoQualitys(item.N_MINFO),
    });
    if (track !== undefined) tracks.push(track);
  }
  return { tracks, total: numberValue(root.TOTAL) ?? tracks.length };
}

function parseKuwoQualitys(value: unknown): Array<QualityEntry> {
  const text = stringValue(value);
  if (text === undefined) return [];
  const entries: Array<QualityEntry> = [];
  for (const part of text.split(";")) {
    const match = /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/u.exec(part);
    if (match === null) continue;
    const type = qualityFromBitrate(match[2]);
    if (type !== undefined) entries.push({ type, size: boundedString(match[4], 32) });
  }
  return uniqueQualitys(entries);
}

async function searchKugou(
  http: MusicOutboundHttp,
  query: string,
  signal?: AbortSignal,
): Promise<SearchPage> {
  const url = new URL("https://songsearch.kugou.com/song_search_v2");
  setParams(url, {
    keyword: query,
    page: "1",
    pagesize: String(SEARCH_LIMIT),
    userid: "0",
    clientver: "",
    platform: "WebFilter",
    filter: "2",
    iscorrection: "1",
    privilege_filter: "0",
    area_code: "1",
  });
  const body = await requestBody(http, url.toString(), getOptions(), signal);
  const root = requireRecord(body, "Kugou search returned invalid data");
  if ((numberValue(root.error_code) ?? -1) !== 0) {
    throw musicSourceError("UPSTREAM_FAILED", "Kugou search failed");
  }
  const data = requireRecord(root.data, "Kugou search result is missing data");
  const candidates: Array<unknown> = [];
  for (const raw of arrayValue(data.lists)) {
    candidates.push(raw);
    const item = recordValue(raw);
    if (item !== undefined) candidates.push(...arrayValue(item.Grp));
  }

  const tracks: Array<MusicSearchTrack> = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const item = recordValue(raw);
    if (item === undefined) continue;
    const songId = scalarValue(item.Audioid);
    const baseHash = stringValue(item.FileHash);
    if (songId === undefined || !baseHash) continue;
    const key = `${songId}_${baseHash}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const qualitys = uniqueQualitys([
      ...kugouQuality(item, "128k", "FileSize", "FileHash"),
      ...kugouQuality(item, "320k", "HQFileSize", "HQFileHash"),
      ...kugouQuality(item, "flac", "SQFileSize", "SQFileHash"),
      ...kugouQuality(item, "flac24bit", "ResFileSize", "ResFileHash"),
    ]);
    const singer = namesFromArray(item.Singers) || cleanText(item.SingerName, 128);
    const track = makeTrack({
      source: "kg",
      songId,
      id: key,
      title: cleanText(item.SongName, 128),
      artist: singer,
      album: cleanText(item.AlbumName, 128),
      albumId: scalarValue(item.AlbumID),
      durationSeconds: durationValue(item.Duration),
      qualitys,
      extraMeta: { hash: baseHash },
    });
    if (track !== undefined) tracks.push(track);
  }
  return { tracks, total: numberValue(data.total) ?? tracks.length };
}

function kugouQuality(
  item: JsonRecord,
  type: MusicSourceQuality,
  sizeKey: string,
  hashKey: string,
): Array<QualityEntry> {
  const size = numberValue(item[sizeKey]);
  const hash = stringValue(item[hashKey]);
  return size !== undefined && size > 0 && hash
    ? [{ type, size: formatBytes(size), hash }]
    : [];
}

async function searchTencent(
  http: MusicOutboundHttp,
  query: string,
  signal?: AbortSignal,
): Promise<SearchPage> {
  const payload = {
    comm: {
      ct: "11",
      cv: "14090508",
      v: "14090508",
      tmeAppID: "qqmusic",
      phonetype: "EBG-AN10",
      deviceScore: "553.47",
      devicelevel: "50",
      newdevicelevel: "20",
      rom: "HuaWei/EMOTION/EmotionUI_14.2.0",
      os_ver: "12",
      OpenUDID: "0",
      OpenUDID2: "0",
      QIMEI36: "0",
      udid: "0",
      chid: "0",
      aid: "0",
      oaid: "0",
      taid: "0",
      tid: "0",
      wid: "0",
      uid: "0",
      sid: "0",
      modeSwitch: "6",
      teenMode: "0",
      ui_mode: "2",
      nettype: "1020",
      v4ip: "",
    },
    req: {
      module: "music.search.SearchCgiService",
      method: "DoSearchForQQMusicMobile",
      param: {
        search_type: 0,
        searchid: Math.random().toString().slice(2),
        query,
        page_num: 1,
        num_per_page: SEARCH_LIMIT,
        highlight: 0,
        nqc_flag: 0,
        multi_zhida: 0,
        cat: 2,
        grp: 1,
        sin: 0,
        sem: 0,
      },
    },
  };
  const sign = tencentSign(JSON.stringify(payload));
  const body = await requestBody(
    http,
    `https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`,
    {
      method: "POST",
      timeout: REQUEST_TIMEOUT_MILLISECONDS,
      headers: { "user-agent": "QQMusic 14090508(android 12)" },
      body: payload,
    },
    signal,
  );
  const root = requireRecord(body, "QQ Music search returned invalid data");
  const requestResult = requireRecord(root.req, "QQ Music search result is missing req");
  if ((numberValue(root.code) ?? -1) !== 0 || (numberValue(requestResult.code) ?? -1) !== 0) {
    throw musicSourceError("UPSTREAM_FAILED", "QQ Music search failed");
  }
  const data = requireRecord(requestResult.data, "QQ Music search result is missing data");
  const resultBody = requireRecord(data.body, "QQ Music search result is missing body");
  const meta = recordValue(data.meta);
  const tracks: Array<MusicSearchTrack> = [];

  for (const raw of arrayValue(resultBody.item_song)) {
    const item = recordValue(raw);
    const file = recordValue(item?.file);
    const mediaMid = stringValue(file?.media_mid);
    const songId = scalarValue(item?.mid);
    if (item === undefined || file === undefined || !mediaMid || songId === undefined) continue;
    const album = recordValue(item.album);
    const albumMid = stringValue(album?.mid) ?? "";
    const qualitys = uniqueQualitys([
      ...sizeQuality(file, "128k", "size_128mp3"),
      ...sizeQuality(file, "320k", "size_320mp3"),
      ...sizeQuality(file, "flac", "size_flac"),
      ...sizeQuality(file, "flac24bit", "size_hires"),
    ]);
    const extraMeta: JsonRecord = { strMediaMid: mediaMid, albumMid };
    const numericId = numberValue(item.id);
    if (numericId !== undefined) {
      extraMeta.id = numericId;
      extraMeta.songId = numericId;
    }
    const track = makeTrack({
      source: "tx",
      songId,
      title: cleanText(item.title, 128),
      artist: namesFromArray(item.singer),
      album: cleanText(album?.name, 128),
      albumId: albumMid,
      durationSeconds: durationValue(item.interval),
      picUrl: albumMid
        ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
        : null,
      qualitys,
      extraMeta,
    });
    if (track !== undefined) tracks.push(track);
  }
  return { tracks, total: numberValue(meta?.estimate_sum) ?? tracks.length };
}

function tencentSign(text: string): string {
  const part1Indexes = [23, 14, 6, 36, 16, 40, 7, 19];
  const part2Indexes = [16, 1, 32, 12, 19, 27, 8, 5];
  const scramble = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];
  const hash = createHash("sha1").update(text).digest("hex");
  const pick = (indexes: ReadonlyArray<number>): string => indexes.map((index) => hash[index] ?? "").join("");
  const bytes = scramble.map((value, index) => value ^ Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16));
  const encoded = Buffer.from(bytes).toString("base64").replace(/[\\/+=]/gu, "");
  return `zzc${pick(part1Indexes)}${encoded}${pick(part2Indexes)}`.toLowerCase();
}

async function searchNetease(
  http: MusicOutboundHttp,
  query: string,
  signal?: AbortSignal,
): Promise<SearchPage> {
  const endpoint = "/api/search/song/list/page";
  const params = neteaseEapi(endpoint, {
    keyword: query,
    needCorrect: "1",
    channel: "typing",
    offset: 0,
    scene: "normal",
    total: true,
    limit: SEARCH_LIMIT,
  });
  const body = await requestBody(
    http,
    "http://interface.music.163.com/eapi/batch",
    {
      method: "POST",
      timeout: REQUEST_TIMEOUT_MILLISECONDS,
      headers: {
        "user-agent": DESKTOP_USER_AGENT,
        origin: "https://music.163.com",
      },
      form: { params },
    },
    signal,
  );
  const root = requireRecord(body, "Netease search returned invalid data");
  if ((numberValue(root.code) ?? -1) !== 200) {
    throw musicSourceError("UPSTREAM_FAILED", "Netease search failed");
  }
  const data = requireRecord(root.data, "Netease search result is missing data");
  const tracks: Array<MusicSearchTrack> = [];

  for (const raw of arrayValue(data.resources)) {
    const resource = recordValue(raw);
    const baseInfo = recordValue(resource?.baseInfo);
    const item = recordValue(baseInfo?.simpleSongData);
    const songId = scalarValue(item?.id);
    const privilege = recordValue(item?.privilege);
    if (item === undefined || songId === undefined || privilege === undefined) continue;
    const album = recordValue(item.al);
    const maximumBitrate = numberValue(privilege.maxbr) ?? 0;
    const qualitys: Array<QualityEntry> = [];
    if (maximumBitrate >= 128_000) qualitys.push(sizeQualityFromRecord(item.l, "128k"));
    if (maximumBitrate >= 320_000) qualitys.push(sizeQualityFromRecord(item.h, "320k"));
    if (maximumBitrate >= 999_000) qualitys.push(sizeQualityFromRecord(item.sq, "flac"));
    if (stringValue(privilege.maxBrLevel) === "hires") {
      qualitys.push(sizeQualityFromRecord(item.hr, "flac24bit"));
    }
    const track = makeTrack({
      source: "wy",
      songId,
      title: cleanText(item.name, 128),
      artist: namesFromArray(item.ar),
      album: cleanText(album?.name, 128),
      albumId: scalarValue(album?.id),
      durationSeconds: millisecondsDuration(item.dt),
      picUrl: stringValue(album?.picUrl) ?? null,
      qualitys: uniqueQualitys(qualitys),
    });
    if (track !== undefined) tracks.push(track);
  }
  return { tracks, total: numberValue(data.totalCount) ?? tracks.length };
}

function neteaseEapi(url: string, object: Readonly<JsonRecord>): string {
  const text = JSON.stringify(object);
  const digest = createHash("md5")
    .update(`nobody${url}use${text}md5forencrypt`)
    .digest("hex");
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const cipher = createCipheriv("aes-128-ecb", Buffer.from("e82ckenh8dichen8"), null);
  return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()])
    .toString("hex")
    .toUpperCase();
}

async function searchMigu(
  http: MusicOutboundHttp,
  query: string,
  signal?: AbortSignal,
): Promise<SearchPage> {
  const timestamp = Date.now().toString();
  const deviceId = "963B7AA0D21511ED807EE5846EC87D20";
  const signature = createHash("md5")
    .update(`${query}6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${timestamp}`)
    .digest("hex");
  const url = new URL("https://jadeite.migu.cn/music_search/v3/search/searchAll");
  setParams(url, {
    isCorrect: "0",
    isCopyright: "1",
    searchSwitch:
      '{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1,"songlist":0,"lyricSong":0}',
    pageSize: String(SEARCH_LIMIT),
    text: query,
    pageNo: "1",
    sort: "0",
    sid: "USS",
  });
  const body = await requestBody(
    http,
    url.toString(),
    {
      method: "GET",
      timeout: REQUEST_TIMEOUT_MILLISECONDS,
      headers: {
        uiVersion: "A_music_3.6.1",
        deviceId,
        timestamp,
        sign: signature,
        channel: "0146921",
        "user-agent":
          "Mozilla/5.0 (Linux; Android 11; MI 11) AppleWebKit/534.30 Mobile Safari/534.30",
      },
    },
    signal,
  );
  const root = requireRecord(body, "Migu search returned invalid data");
  if (stringValue(root.code) !== "000000") {
    throw musicSourceError("UPSTREAM_FAILED", "Migu search failed");
  }
  const data = requireRecord(root.songResultData, "Migu search result is missing data");
  const tracks: Array<MusicSearchTrack> = [];
  const seen = new Set<string>();

  for (const group of arrayValue(data.resultList)) {
    for (const raw of Array.isArray(group) ? group : [group]) {
      const item = recordValue(raw);
      const songId = scalarValue(item?.songId);
      const copyrightId = stringValue(item?.copyrightId);
      if (item === undefined || songId === undefined || !copyrightId || seen.has(copyrightId)) continue;
      seen.add(copyrightId);
      const qualitys: Array<QualityEntry> = [];
      for (const rawFormat of arrayValue(item.audioFormats)) {
        const format = recordValue(rawFormat);
        if (format === undefined) continue;
        const type = miguQuality(stringValue(format.formatType));
        const size = numberValue(format.asize) ?? numberValue(format.isize);
        if (type !== undefined) qualitys.push({ type, size: size === undefined ? null : formatBytes(size) });
      }
      const extraMeta: JsonRecord = { copyrightId };
      copyStrings(item, extraMeta, ["lrcUrl", "mrcUrl", "trcUrl"]);
      const track = makeTrack({
        source: "mg",
        songId,
        title: cleanText(item.name, 128),
        artist: namesFromArray(item.singerList),
        album: cleanText(item.album, 128),
        albumId: scalarValue(item.albumId),
        durationSeconds: durationValue(item.duration),
        picUrl: stringValue(item.img3) ?? stringValue(item.img2) ?? stringValue(item.img1) ?? null,
        qualitys: uniqueQualitys(qualitys),
        extraMeta,
      });
      if (track !== undefined) tracks.push(track);
    }
  }
  return { tracks, total: numberValue(data.totalCount) ?? tracks.length };
}

function miguQuality(value: string | undefined): MusicSourceQuality | undefined {
  switch (value) {
    case "PQ":
      return "128k";
    case "HQ":
      return "320k";
    case "SQ":
      return "flac";
    case "ZQ24":
      return "flac24bit";
    default:
      return undefined;
  }
}

function makeTrack(input: TrackInput): MusicSearchTrack | undefined {
  const title = boundedString(input.title.trim(), 128);
  if (!title) return undefined;
  const qualitys = uniqueQualitys(input.qualitys);
  if (qualitys.length === 0) return undefined;
  const durationSeconds = normalizeDuration(input.durationSeconds);
  const qualityList: Array<JsonRecord> = [];
  const qualityMap: JsonRecord = {};
  for (const quality of qualitys) {
    const description: JsonRecord = { size: quality.size };
    if (quality.hash !== undefined) description.hash = quality.hash;
    qualityMap[quality.type] = description;
    qualityList.push({ type: quality.type, ...description });
  }
  const meta: JsonRecord = {
    songId: input.songId,
    albumName: boundedString(input.album, 128),
    picUrl: input.picUrl ? boundedString(input.picUrl, 2_048) : null,
    qualitys: qualityList,
    _qualitys: qualityMap,
  };
  if (input.albumId !== undefined) meta.albumId = input.albumId;
  if (input.extraMeta !== undefined) Object.assign(meta, input.extraMeta);

  const id = boundedString(input.id ?? `${input.source}_${input.songId}`, 256);
  const artist = boundedString(input.artist, 128);
  const album = boundedString(input.album, 128);
  // LX search adapters historically return this flat shape. Current LX versions also expose
  // the nested meta shape. Keep both so old and new custom source scripts can resolve the result.
  const musicInfo: JsonRecord = {
    id,
    name: title,
    singer: artist,
    source: input.source,
    songmid: input.songId,
    interval: durationSeconds === null ? null : formatDuration(durationSeconds),
    albumName: album,
    albumId: input.albumId ?? "",
    img: input.picUrl ? boundedString(input.picUrl, 2_048) : null,
    types: qualityList,
    _types: qualityMap,
    typeUrl: {},
    meta,
  };
  if (input.extraMeta !== undefined) Object.assign(musicInfo, input.extraMeta);
  musicInfo.id = id;
  return MusicSearchTrack.make({
    id,
    source: input.source,
    title,
    artist,
    album,
    durationSeconds,
    qualitys: qualitys.map((quality) => quality.type),
    musicInfo,
  });
}

async function requestBody(
  http: MusicOutboundHttp,
  url: string,
  options: Readonly<JsonRecord>,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await http.request(url, options, signal);
  if (result.response.statusCode < 200 || result.response.statusCode >= 300) {
    throw musicSourceError("UPSTREAM_FAILED", `Music search returned HTTP ${result.response.statusCode}`);
  }
  return result.body;
}

function getOptions(): JsonRecord {
  return {
    method: "GET",
    timeout: REQUEST_TIMEOUT_MILLISECONDS,
    headers: { "user-agent": DESKTOP_USER_AGENT },
  };
}

function setParams(url: URL, values: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
}

function requireRecord(value: unknown, message: string): JsonRecord {
  const record = recordValue(value);
  if (record === undefined) throw musicSourceError("UPSTREAM_FAILED", message);
  return record;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function arrayValue(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function scalarValue(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function durationValue(value: unknown): number | null {
  return normalizeDuration(numberValue(value) ?? null);
}

function millisecondsDuration(value: unknown): number | null {
  const milliseconds = numberValue(value);
  return milliseconds === undefined ? null : normalizeDuration(milliseconds / 1_000);
}

function normalizeDuration(value: number | null): number | null {
  return value === null || !Number.isFinite(value)
    ? null
    : Math.min(86_400, Math.max(0, Math.round(value)));
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function namesFromArray(value: unknown): string {
  const names: Array<string> = [];
  for (const raw of arrayValue(value)) {
    const item = recordValue(raw);
    const name = cleanText(item?.name, 128);
    if (name) names.push(name);
  }
  return boundedString(names.join("、"), 128);
}

function cleanText(value: unknown, maximum: number): string {
  const raw = stringValue(value) ?? "";
  return boundedString(decodeHtml(raw).replace(/\\s+/gu, " ").trim(), maximum);
}

function decodeHtml(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith("#x")) {
      const code = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (normalized.startsWith("#")) {
      const code = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return named[normalized] ?? whole;
  });
}

function boundedString(value: string | undefined, maximum: number): string {
  if (value === undefined) return "";
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function qualityFromBitrate(value: string | undefined): MusicSourceQuality | undefined {
  switch (value) {
    case "128":
      return "128k";
    case "320":
      return "320k";
    case "2000":
      return "flac";
    case "4000":
      return "flac24bit";
    default:
      return undefined;
  }
}

function sizeQuality(
  record: JsonRecord,
  type: MusicSourceQuality,
  key: string,
): Array<QualityEntry> {
  const size = numberValue(record[key]);
  return size !== undefined && size > 0 ? [{ type, size: formatBytes(size) }] : [];
}

function sizeQualityFromRecord(value: unknown, type: MusicSourceQuality): QualityEntry {
  const size = numberValue(recordValue(value)?.size);
  return { type, size: size === undefined ? null : formatBytes(size) };
}

function uniqueQualitys(values: ReadonlyArray<QualityEntry>): Array<QualityEntry> {
  const byType = new Map<MusicSourceQuality, QualityEntry>();
  for (const value of values) {
    if (!byType.has(value.type)) byType.set(value.type, value);
  }
  return QUALITY_ORDER.flatMap((type) => {
    const value = byType.get(type);
    return value === undefined ? [] : [value];
  });
}

function formatBytes(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const megabytes = bytes / 1_048_576;
  return `${megabytes < 10 ? megabytes.toFixed(2) : megabytes.toFixed(1)}M`;
}

function copyStrings(source: JsonRecord, target: JsonRecord, keys: ReadonlyArray<string>): void {
  for (const key of keys) {
    const value = stringValue(source[key]);
    if (value !== undefined) target[key] = boundedString(value, 2_048);
  }
}

function boundedTotal(value: number): number {
  return Math.min(1_000_000_000, Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0)));
}
