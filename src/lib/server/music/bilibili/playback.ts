import { Schema } from "effect";
import type { BilibiliAudioQuality } from "../../../protocol";
import {
  BilibiliPlayUrlResponse,
  BilibiliResolvedAudio,
  type BilibiliDashAudio,
} from "./contracts";
import type { BilibiliApiClient } from "./client";
import { bilibiliError, isBilibiliError, throwForBilibiliCode } from "./errors";
import type { WbiSigner } from "./wbi";

const TARGET_AUDIO_ID: Readonly<Record<BilibiliAudioQuality, number>> = {
  "64k": 30_216,
  "132k": 30_232,
  "192k": 30_280,
};
const QUALITY_ORDER: ReadonlyArray<BilibiliAudioQuality> = ["64k", "132k", "192k"];
const MAX_CACHE_ENTRIES = 128;
const FALLBACK_CACHE_MILLISECONDS = 60_000;
const MAX_CACHE_MILLISECONDS = 5 * 60_000;
const EXPIRY_SKEW_MILLISECONDS = 60_000;

interface CachedAudio {
  readonly value: BilibiliResolvedAudio;
}

export class BilibiliPlayback {
  private readonly cache = new Map<string, CachedAudio>();

  constructor(
    private readonly client: BilibiliApiClient,
    private readonly signer: WbiSigner,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(
    bvid: string,
    cid: number,
    quality: BilibiliAudioQuality,
    signal?: AbortSignal,
    force = false,
  ): Promise<BilibiliResolvedAudio> {
    if (!isAudioQuality(quality)) {
      throw bilibiliError("INVALID_REQUEST", "playback.resolve", "Unsupported Bilibili audio quality");
    }
    const key = cacheKey(bvid, cid, quality);
    const cached = this.cache.get(key);
    if (!force && cached !== undefined && cached.value.expiresAt > this.now()) return cached.value;

    try {
      const signed = await this.signer.sign(
        {
          bvid,
          cid,
          fnval: 4048,
          fnver: 0,
          fourk: 1,
          qlt: TARGET_AUDIO_ID[quality],
          voice_balance: 1,
        },
        signal,
      );
      const raw = await this.client.get("/x/player/wbi/playurl", signed, signal);
      const response = await Schema.decodeUnknownPromise(BilibiliPlayUrlResponse)(raw);
      throwForBilibiliCode(response.code, "playback.playurl", response.message ?? "");
      if (response.data === null) {
        throw bilibiliError("NO_AUDIO", "playback.playurl", "Bilibili returned no playback data");
      }

      const selected = selectAudio(response.data, quality);
      const urls = uniqueHttpsUrls(selected.urls);
      if (urls.length === 0) {
        throw bilibiliError("PROTOCOL_ERROR", "playback.playurl", "Bilibili returned invalid media URLs");
      }
      const value = BilibiliResolvedAudio.make({
        bvid,
        cid,
        quality: selected.quality,
        urls,
        mimeType: selected.mimeType,
        expiresAt: calculateExpiry(urls, this.now()),
      });
      this.remember(key, value);
      return value;
    } catch (cause) {
      if (isBilibiliError(cause)) throw cause;
      throw bilibiliError(
        "PROTOCOL_ERROR",
        "playback.playurl",
        "Bilibili playback response failed validation",
      );
    }
  }

  invalidate(bvid: string, cid: number, quality: BilibiliAudioQuality): void {
    this.cache.delete(cacheKey(bvid, cid, quality));
  }

  private remember(key: string, value: BilibiliResolvedAudio): void {
    this.cache.delete(key);
    this.cache.set(key, { value });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

interface AudioSelection {
  readonly quality: BilibiliAudioQuality;
  readonly urls: ReadonlyArray<string>;
  readonly mimeType: string | null;
}

export function selectAudio(
  data: BilibiliPlayUrlResponse["data"] & object,
  quality: BilibiliAudioQuality,
): AudioSelection {
  const requestedRank = QUALITY_ORDER.indexOf(quality);
  for (const candidate of QUALITY_ORDER.slice(0, requestedRank + 1).reverse()) {
    const selected = selectExactAudio(data, candidate);
    if (selected !== undefined) return selected;
  }
  throw bilibiliError(
    "NO_AUDIO",
    "playback.select",
    `No Bilibili audio is available at or below ${quality}`,
  );
}

function selectExactAudio(
  data: BilibiliPlayUrlResponse["data"] & object,
  quality: BilibiliAudioQuality,
): AudioSelection | undefined {
  const target = data.dash?.audio?.find((audio) => audio.id === TARGET_AUDIO_ID[quality]);
  if (target !== undefined) {
    return {
      quality,
      urls: audioUrls(target),
      mimeType: target.mimeType ?? target.mime_type ?? null,
    };
  }
  if (quality !== "64k") return undefined;

  const legacy = data.durl?.[0];
  return legacy === undefined
    ? undefined
    : {
        quality,
        urls: [legacy.url, ...(legacy.backup_url ?? legacy.backupUrl ?? [])],
        mimeType: "audio/mp4",
      };
}

function isAudioQuality(value: string): value is BilibiliAudioQuality {
  return value === "64k" || value === "132k" || value === "192k";
}

function audioUrls(audio: BilibiliDashAudio): ReadonlyArray<string> {
  const primary = audio.baseUrl ?? audio.base_url;
  return primary === undefined ? [] : [primary, ...(audio.backupUrl ?? audio.backup_url ?? [])];
}

function uniqueHttpsUrls(values: ReadonlyArray<string>): Array<string> {
  const result = new Set<string>();
  for (const value of values) {
    const candidate = value.startsWith("http://") ? `https://${value.slice(7)}` : value;
    try {
      const url = new URL(candidate);
      if (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        (url.port === "" || url.port === "443")
      ) {
        result.add(url.href);
      }
    } catch {
      // Invalid upstream candidate; other backup URLs may still be usable.
    }
  }
  return [...result].slice(0, 8);
}

function calculateExpiry(urls: ReadonlyArray<string>, now: number): number {
  let deadline: number | undefined;
  for (const value of urls) {
    const url = new URL(value);
    const seconds = Number(url.searchParams.get("deadline") ?? url.searchParams.get("expires"));
    if (Number.isFinite(seconds) && seconds > 0) {
      const candidate = seconds * 1_000 - EXPIRY_SKEW_MILLISECONDS;
      deadline = deadline === undefined ? candidate : Math.min(deadline, candidate);
    }
  }
  return deadline === undefined
    ? now + FALLBACK_CACHE_MILLISECONDS
    : Math.max(now, Math.min(deadline, now + MAX_CACHE_MILLISECONDS));
}

function cacheKey(bvid: string, cid: number, quality: BilibiliAudioQuality): string {
  return `${bvid}:${cid}:${quality}`;
}
