import { BILIBILI_MEDIA_HEADERS, type BilibiliFetch } from "./client";
import { bilibiliError, isBilibiliError } from "./errors";
import type { BilibiliPlayback } from "./playback";
import type { BilibiliTicketService } from "./ticket";

const MEDIA_HOST_SUFFIXES = [
  "bilivideo.com",
  "bilivideo.cn",
  "akamaized.net",
  "biliapi.net",
  "szbdyd.com",
];
const RANGE_PATTERN = /^bytes=(?:\d+-\d*|-\d+)$/u;
const MEDIA_HEADER_TIMEOUT_MILLISECONDS = 10_000;
const RESPONSE_HEADERS = ["accept-ranges", "content-range", "content-type"];

export const BILIBILI_STREAM_PATH_PREFIX = "/api/music/stream/";

export class BilibiliStreamProxy {
  constructor(
    private readonly tickets: BilibiliTicketService,
    private readonly playback: BilibiliPlayback,
    private readonly fetcher: BilibiliFetch = globalThis.fetch,
    private readonly headerTimeoutMilliseconds = MEDIA_HEADER_TIMEOUT_MILLISECONDS,
  ) {}

  async serve(request: Request, token: string): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const range = request.headers.get("range");
    if (range !== null && !RANGE_PATTERN.test(range)) {
      return new Response("Invalid or unsupported Range", {
        status: 416,
        headers: { "cache-control": "private, no-store" },
      });
    }

    const ticket = await this.tickets.verifyStream(token);
    let audio = await this.playback.resolve(
      ticket.bvid,
      ticket.cid,
      ticket.quality,
      request.signal,
    );
    let response = await this.fetchCandidates(request, audio.urls, range);
    if (response === undefined) {
      this.playback.invalidate(ticket.bvid, ticket.cid, ticket.quality);
      audio = await this.playback.resolve(
        ticket.bvid,
        ticket.cid,
        ticket.quality,
        request.signal,
        true,
      );
      response = await this.fetchCandidates(request, audio.urls, range);
    }
    if (response === undefined) {
      throw bilibiliError("UPSTREAM_FAILED", "stream.media", "Bilibili media servers are unavailable");
    }
    return proxyResponse(request.method, response);
  }

  private async fetchCandidates(
    request: Request,
    candidates: ReadonlyArray<string>,
    range: string | null,
  ): Promise<Response | undefined> {
    let timedOut = false;
    for (const candidate of candidates) {
      const url = validateMediaUrl(candidate);
      if (url === undefined) continue;
      const headerTimeout = new AbortController();
      const timer = setTimeout(
        () => headerTimeout.abort(new Error("Bilibili media response headers timed out")),
        this.headerTimeoutMilliseconds,
      );
      try {
        const headers = new Headers(BILIBILI_MEDIA_HEADERS);
        if (range !== null) headers.set("range", range);
        const response = await this.fetcher(url, {
          method: request.method,
          headers,
          redirect: "error",
          signal: AbortSignal.any([request.signal, headerTimeout.signal]),
        });
        clearTimeout(timer);
        if (response.status === 200 || response.status === 206 || response.status === 416) {
          return response;
        }
        await cancelBody(response);
      } catch (cause) {
        if (request.signal.aborted) {
          throw bilibiliError("TIMEOUT", "stream.media", "Music stream request was cancelled");
        }
        if (headerTimeout.signal.aborted) {
          timedOut = true;
          continue;
        }
        if (isBilibiliError(cause)) throw cause;
      } finally {
        clearTimeout(timer);
      }
    }
    if (timedOut) {
      throw bilibiliError("TIMEOUT", "stream.media", "Bilibili media response timed out");
    }
    return undefined;
  }
}

function proxyResponse(method: string, upstream: Response): Response {
  const headers = new Headers({ "cache-control": "private, no-store" });
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (!headers.has("accept-ranges") && upstream.status !== 416) headers.set("accept-ranges", "bytes");
  if (method === "HEAD") {
    const contentLength = upstream.headers.get("content-length");
    if (contentLength !== null) headers.set("content-length", contentLength);
    void cancelBody(upstream);
    return new Response(null, { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

function validateMediaUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (url.port !== "" && url.port !== "443")
    ) {
      return undefined;
    }
    const hostname = url.hostname.toLowerCase();
    return MEDIA_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    )
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The upstream may already have closed the body.
  }
}
