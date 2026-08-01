import type { MusicSourcePlatform } from "../../protocol";
import { musicSourceError } from "./errors";
import { MusicOutboundHttp } from "./outbound-http";

const REQUEST_TIMEOUT_MILLISECONDS = 8_000;
const BUILTIN_PICTURE_SOURCES: ReadonlyArray<MusicSourcePlatform> = ["kw", "kg", "tx", "mg"];

type JsonRecord = Record<string, unknown>;

export function hasBuiltinPictureResolver(source: MusicSourcePlatform): boolean {
  return BUILTIN_PICTURE_SOURCES.includes(source);
}

/** Online picture resolvers mirrored from LX Music Desktop's built-in musicSdk implementations. */
export class MusicPictureResolver {
  constructor(private readonly http: MusicOutboundHttp) {}

  async resolve(
    source: MusicSourcePlatform,
    requestInfo: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    const musicInfo = requireMusicInfo(requestInfo);
    switch (source) {
      case "kw":
        return this.resolveKuwo(musicInfo, signal);
      case "kg":
        return this.resolveKugou(musicInfo, signal);
      case "tx":
        return resolveTencent(musicInfo);
      case "mg":
        return this.resolveMigu(musicInfo, signal);
      case "wy":
      case "local":
        throw musicSourceError("INVALID_REQUEST", "No built-in picture resolver for source");
    }
  }

  private async resolveKuwo(musicInfo: JsonRecord, signal?: AbortSignal): Promise<string> {
    const songId = scalarText(musicInfo.songmid) ?? scalarText(recordValue(musicInfo.meta)?.songId);
    if (!songId) throw musicSourceError("INVALID_REQUEST", "Kuwo picture requires songmid");
    const url = new URL("http://artistpicserver.kuwo.cn/pic.web");
    url.searchParams.set("corp", "kuwo");
    url.searchParams.set("type", "rid_pic");
    url.searchParams.set("pictype", "500");
    url.searchParams.set("size", "500");
    url.searchParams.set("rid", songId);
    const body = await requestBody(this.http, url.toString(), { method: "GET" }, signal);
    if (typeof body !== "string" || !/^https?:\/\/\S+$/iu.test(body.trim())) {
      throw musicSourceError("UPSTREAM_FAILED", "Kuwo returned an invalid picture URL");
    }
    return preferHttps(body.trim());
  }

  private async resolveMigu(musicInfo: JsonRecord, signal?: AbortSignal): Promise<string> {
    const songId = scalarText(musicInfo.songmid) ?? scalarText(recordValue(musicInfo.meta)?.songId);
    if (!songId) throw musicSourceError("INVALID_REQUEST", "Migu picture requires songmid");
    const url = new URL("http://music.migu.cn/v3/api/music/audioPlayer/getSongPic");
    url.searchParams.set("songId", songId);
    const body = await requestBody(
      this.http,
      url.toString(),
      {
        method: "GET",
        headers: { Referer: "http://music.migu.cn/v3/music/player/audio?from=migu" },
      },
      signal,
    );
    const result = recordValue(body);
    const picture =
      stringValue(result?.largePic) ??
      stringValue(result?.mediumPic) ??
      stringValue(result?.smallPic);
    if (stringValue(result?.returnCode) !== "000000" || !picture) {
      throw musicSourceError("UPSTREAM_FAILED", "Migu returned an invalid picture response");
    }
    const normalized = picture.startsWith("//") ? "https:" + picture : picture;
    return preferHttps(normalized);
  }

  private async resolveKugou(musicInfo: JsonRecord, signal?: AbortSignal): Promise<string> {
    const songId = scalarText(musicInfo.songmid) ?? scalarText(recordValue(musicInfo.meta)?.songId);
    const albumId = scalarText(musicInfo.albumId) ?? scalarText(recordValue(musicInfo.meta)?.albumId) ?? "";
    const hash = stringValue(musicInfo.hash) ?? "";
    if (!songId) throw musicSourceError("INVALID_REQUEST", "Kugou picture requires songmid");
    const body = await requestBody(
      this.http,
      "http://media.store.kugou.com/v1/get_res_privilege",
      {
        method: "POST",
        headers: {
          "KG-RC": "1",
          "KG-THash": "expand_search_manager.cpp:852736169:451",
          "User-Agent": "KuGou2012-9020-ExpandSearchManager",
        },
        body: {
          appid: 1001,
          area_code: "1",
          behavior: "play",
          clientver: "9020",
          need_hash_offset: 1,
          relate: 1,
          resource: [
            {
              album_audio_id: songId,
              album_id: albumId,
              hash,
              id: 0,
              name: (stringValue(musicInfo.singer) ?? "") + " - " + (stringValue(musicInfo.name) ?? "") + ".mp3",
              type: "audio",
            },
          ],
          token: "",
          userid: 2_626_431_536,
          vip: 1,
        },
      },
      signal,
    );
    const root = recordValue(body);
    const first = arrayValue(root?.data)[0];
    const info = recordValue(recordValue(first)?.info);
    const image = stringValue(info?.image);
    if ((numberValue(root?.error_code) ?? -1) !== 0 || !image) {
      throw musicSourceError("UPSTREAM_FAILED", "Kugou returned an invalid picture response");
    }
    const size = scalarText(arrayValue(info?.imgsize)[0]) ?? "400";
    return preferHttps(image.replace("{size}", size));
  }
}

function resolveTencent(musicInfo: JsonRecord): string {
  const meta = recordValue(musicInfo.meta);
  const albumId =
    scalarText(musicInfo.albumId) ?? scalarText(musicInfo.albumMid) ?? scalarText(meta?.albumId);
  if (!albumId) throw musicSourceError("INVALID_REQUEST", "Tencent picture requires albumId");
  return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg`;
}

async function requestBody(
  http: MusicOutboundHttp,
  url: string,
  options: JsonRecord,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await http.request(
    url,
    { timeout: REQUEST_TIMEOUT_MILLISECONDS, ...options },
    signal,
  );
  if (result.response.statusCode < 200 || result.response.statusCode >= 300) {
    throw musicSourceError("UPSTREAM_FAILED", `Picture request returned HTTP ${result.response.statusCode}`);
  }
  return result.body;
}

function requireMusicInfo(value: unknown): JsonRecord {
  const info = recordValue(value);
  const musicInfo = recordValue(info?.musicInfo);
  if (musicInfo === undefined) {
    throw musicSourceError("INVALID_REQUEST", "Picture request is missing musicInfo");
  }
  return musicInfo;
}

function preferHttps(value: string): string {
  return value.startsWith("http://") ? "https://" + value.slice(7) : value;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function arrayValue(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function scalarText(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
