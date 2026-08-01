import { bilibiliError, isBilibiliError } from "./errors";
import type { BilibiliCredentials } from "./credentials";

const API_ORIGIN = "https://api.bilibili.com";
const MAX_RESPONSE_BYTES = 2_097_152;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAX_API_REQUESTS_PER_MINUTE = 120;
const MAX_CONCURRENT_API_REQUESTS = 8;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type BilibiliEndpoint =
  | "/x/web-interface/nav"
  | "/x/web-interface/wbi/search/type"
  | "/x/player/pagelist"
  | "/x/player/wbi/playurl";

export type BilibiliFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type BilibiliBeforeRequest = (signal?: AbortSignal) => Promise<void>;

export class BilibiliApiClient {
  private readonly requestTimes: Array<number> = [];
  private inFlight = 0;

  constructor(
    private readonly credentials: BilibiliCredentials,
    private readonly fetcher: BilibiliFetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
    private readonly beforeRequest?: BilibiliBeforeRequest,
  ) {}

  async get(
    endpoint: BilibiliEndpoint,
    query: string | URLSearchParams | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(endpoint, API_ORIGIN);
    if (typeof query === "string") url.search = query;
    else if (query !== undefined) url.search = query.toString();

    await this.beforeRequest?.(signal);
    this.acquire(endpoint);
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", relayAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Bilibili API request timed out")),
      REQUEST_TIMEOUT_MILLISECONDS,
    );

    try {
      const response = await this.fetcher(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          cookie: this.credentials.headerValue(),
          origin: "https://www.bilibili.com",
          referer: "https://www.bilibili.com/",
          "user-agent": USER_AGENT,
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status === 429) {
        throw bilibiliError("RATE_LIMITED", endpoint, "Bilibili API rate limited the request", {
          status: response.status,
        });
      }
      if (!response.ok) {
        throw bilibiliError("UPSTREAM_FAILED", endpoint, "Bilibili API returned an HTTP error", {
          status: response.status,
        });
      }
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw bilibiliError("PROTOCOL_ERROR", endpoint, "Bilibili API response is too large");
      }
      const text = await readBoundedText(response, endpoint);
      try {
        const parsed: unknown = JSON.parse(text);
        return parsed;
      } catch {
        throw bilibiliError("PROTOCOL_ERROR", endpoint, "Bilibili API returned invalid JSON");
      }
    } catch (cause) {
      if (isBilibiliError(cause)) throw cause;
      if (controller.signal.aborted) {
        throw bilibiliError("TIMEOUT", endpoint, "Bilibili API request was cancelled or timed out");
      }
      throw bilibiliError("UPSTREAM_FAILED", endpoint, "Bilibili API request failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relayAbort);
      this.inFlight -= 1;
    }
  }

  private acquire(operation: BilibiliEndpoint): void {
    const cutoff = this.now() - 60_000;
    while (this.requestTimes[0] !== undefined && this.requestTimes[0] <= cutoff) {
      this.requestTimes.shift();
    }
    if (
      this.inFlight >= MAX_CONCURRENT_API_REQUESTS ||
      this.requestTimes.length >= MAX_API_REQUESTS_PER_MINUTE
    ) {
      throw bilibiliError("RATE_LIMITED", operation, "Bilibili API request budget is exhausted");
    }
    this.inFlight += 1;
    this.requestTimes.push(this.now());
  }
}

async function readBoundedText(response: Response, operation: BilibiliEndpoint): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw bilibiliError("PROTOCOL_ERROR", operation, "Bilibili API response is too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export const BILIBILI_MEDIA_HEADERS = {
  referer: "https://www.bilibili.com/",
  "user-agent": USER_AGENT,
} satisfies Readonly<Record<string, string>>;
