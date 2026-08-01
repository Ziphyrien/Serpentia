import { Schema } from "effect";
import { decode as decodeHtml } from "he";
import {
  BilibiliPageListResponse,
  BilibiliSearchResponse,
  BilibiliTrack,
  isBilibiliBvid,
} from "./contracts";
import type { BilibiliApiClient } from "./client";
import { bilibiliError, isBilibiliError, throwForBilibiliCode } from "./errors";
import type { WbiSigner } from "./wbi";

const SEARCH_CACHE_TTL_MILLISECONDS = 5 * 60 * 1_000;
const MAX_SEARCH_CACHE_ENTRIES = 64;
const SEARCH_PAGE_SIZE = 20;

export interface BilibiliSearchResult {
  readonly total: number;
  readonly tracks: ReadonlyArray<BilibiliTrack>;
  readonly nextPage: number | null;
}

interface CachedSearch {
  readonly expiresAt: number;
  readonly value: BilibiliSearchResult;
}

export class BilibiliCatalog {
  private readonly searchCache = new Map<string, CachedSearch>();

  constructor(
    private readonly client: BilibiliApiClient,
    private readonly signer: WbiSigner,
    private readonly now: () => number = Date.now,
  ) {}

  async search(
    query: string,
    page = 1,
    signal?: AbortSignal,
  ): Promise<BilibiliSearchResult> {
    const normalized = query.trim().replace(/\s+/gu, " ");
    if (!normalized || !Number.isInteger(page) || page < 1) {
      throw bilibiliError("INVALID_REQUEST", "catalog.search", "Invalid search request");
    }
    const key = `${normalized.toLocaleLowerCase("zh-CN")}\u0000${page}`;
    const cached = this.searchCache.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.value;

    try {
      const response = await this.searchPage(normalized, page, signal);
      const videos = response.data?.result ?? [];
      const seen = new Set<string>();
      const tracks = videos.flatMap((video) => {
        const title = normalizeText(video.title, 128);
        if (!isBilibiliBvid(video.bvid) || !title || seen.has(video.bvid)) return [];
        seen.add(video.bvid);
        return [
          BilibiliTrack.make({
            bvid: video.bvid,
            title,
            artist: normalizeText(video.author, 128),
            pictureUrl: normalizePictureUrl(video.pic),
            durationSeconds: parseDuration(video.duration),
            cid: null,
          }),
        ];
      });
      const pageCount = Math.max(page, response.data?.numPages ?? page);
      const value: BilibiliSearchResult = {
        total: Math.max(0, response.data?.numResults ?? tracks.length),
        tracks,
        nextPage: page < pageCount ? page + 1 : null,
      };
      this.rememberSearch(key, value);
      return value;
    } catch (cause) {
      if (isBilibiliError(cause)) throw cause;
      throw bilibiliError("PROTOCOL_ERROR", "catalog.search", "Bilibili search response failed validation");
    }
  }

  private async searchPage(
    query: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<BilibiliSearchResponse> {
    const signed = await this.signer.sign(
      { keyword: query, search_type: "video", page, page_size: SEARCH_PAGE_SIZE },
      signal,
    );
    const raw = await this.client.get("/x/web-interface/wbi/search/type", signed, signal);
    const response = await Schema.decodeUnknownPromise(BilibiliSearchResponse)(raw);
    throwForBilibiliCode(response.code, "catalog.search", response.message);
    return response;
  }

  async firstPageCid(bvid: string, signal?: AbortSignal): Promise<number> {
    try {
      const query = new URLSearchParams({ bvid });
      const raw = await this.client.get("/x/player/pagelist", query, signal);
      const response = await Schema.decodeUnknownPromise(BilibiliPageListResponse)(raw);
      throwForBilibiliCode(response.code, "catalog.pagelist", response.message);
      const cid = response.data?.[0]?.cid;
      if (cid === undefined) {
        throw bilibiliError("NOT_FOUND", "catalog.pagelist", "Bilibili video has no playable page");
      }
      return cid;
    } catch (cause) {
      if (isBilibiliError(cause)) throw cause;
      throw bilibiliError(
        "PROTOCOL_ERROR",
        "catalog.pagelist",
        "Bilibili page list response failed validation",
      );
    }
  }

  private rememberSearch(key: string, value: BilibiliSearchResult): void {
    this.searchCache.delete(key);
    this.searchCache.set(key, { value, expiresAt: this.now() + SEARCH_CACHE_TTL_MILLISECONDS });
    while (this.searchCache.size > MAX_SEARCH_CACHE_ENTRIES) {
      const oldest = this.searchCache.keys().next().value;
      if (oldest === undefined) break;
      this.searchCache.delete(oldest);
    }
  }
}

function normalizeText(value: string, maximumLength: number): string {
  const decoded = decodeHtml(value.replace(/<[^>]*>/gu, ""))
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...decoded].slice(0, maximumLength).join("");
}

function normalizePictureUrl(value: string): string | null {
  const candidate = value.startsWith("//")
    ? `https:${value}`
    : value.startsWith("http://")
      ? `https://${value.slice("http://".length)}`
      : value;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
      ? parsed.href.slice(0, 512)
      : null;
  } catch {
    return null;
  }
}

function parseDuration(value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  const parts = value.split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d+$/u.test(part))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + Number(part);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400 ? seconds : null;
}
