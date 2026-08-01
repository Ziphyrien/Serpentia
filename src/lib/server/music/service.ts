import {
  MusicBackendStatusResponse,
  MusicResolvedTrack,
  MusicSearchResponse,
  MusicSearchTrack,
  type BilibiliAudioQuality,
  type MusicBackendErrorCode,
  type MusicSearchRequest,
} from "../../protocol";
import { BilibiliCatalog } from "./bilibili/catalog";
import { BilibiliApiClient, type BilibiliFetch } from "./bilibili/client";
import { BILIBILI_REGULAR_QUALITIES } from "./bilibili/contracts";
import { BilibiliCredentials } from "./bilibili/credentials";
import { type BilibiliError, isBilibiliError } from "./bilibili/errors";
import { BilibiliPlayback } from "./bilibili/playback";
import { BilibiliSessionRefresher } from "./bilibili/refresh";
import { BILIBILI_STREAM_PATH_PREFIX, BilibiliStreamProxy } from "./bilibili/stream";
import { BilibiliTicketService } from "./bilibili/ticket";
import { WbiSigner } from "./bilibili/wbi";
import { isMusicBackendError, musicBackendError } from "./errors";

interface MusicBackendDependencies {
  readonly catalog: BilibiliCatalog;
  readonly playback: BilibiliPlayback;
  readonly tickets: BilibiliTicketService;
  readonly streams: BilibiliStreamProxy;
  readonly signer: WbiSigner;
  readonly refresher: BilibiliSessionRefresher | undefined;
}

export interface MusicBackendServiceOptions {
  readonly bilibiliCookie: string;
  readonly signingSecret: string;
  readonly fetch?: BilibiliFetch;
  readonly now?: () => number;
  readonly mediaHeaderTimeoutMilliseconds?: number;
  readonly refreshToken?: string;
  readonly environmentFile?: string;
}

export class MusicBackendService {
  private constructor(private readonly dependencies: MusicBackendDependencies | undefined) {}

  static disabled(): MusicBackendService {
    return new MusicBackendService(undefined);
  }

  static create(options: MusicBackendServiceOptions): MusicBackendService {
    const now = options.now ?? Date.now;
    const credentials = BilibiliCredentials.fromEnvironment(options.bilibiliCookie);
    const refreshConfigured =
      options.refreshToken !== undefined || options.environmentFile !== undefined;
    if (
      refreshConfigured &&
      (options.refreshToken === undefined || options.environmentFile === undefined)
    ) {
      throw musicBackendError(
        "BACKEND_UNAVAILABLE",
        "Bilibili refresh token and environment file must be configured together",
      );
    }
    const refresher =
      options.refreshToken === undefined || options.environmentFile === undefined
        ? undefined
        : new BilibiliSessionRefresher(credentials, {
            refreshToken: options.refreshToken,
            environmentFile: options.environmentFile,
            fetch: options.fetch,
            now,
          });
    const client = new BilibiliApiClient(
      credentials,
      options.fetch,
      now,
      refresher === undefined ? undefined : (signal) => refresher.ensureFresh(signal),
    );
    const signer = new WbiSigner(client, now);
    const catalog = new BilibiliCatalog(client, signer, now);
    const playback = new BilibiliPlayback(client, signer, now);
    const tickets = new BilibiliTicketService(options.signingSecret, now);
    const streams = new BilibiliStreamProxy(
      tickets,
      playback,
      options.fetch,
      options.mediaHeaderTimeoutMilliseconds,
    );
    refresher?.start();
    return new MusicBackendService({ catalog, playback, tickets, streams, signer, refresher });
  }

  async status(signal?: AbortSignal): Promise<MusicBackendStatusResponse> {
    if (this.dependencies === undefined) {
      return MusicBackendStatusResponse.make({
        source: "bilibili",
        available: false,
        qualities: [],
      });
    }
    try {
      await this.dependencies.signer.ready(signal);
      return MusicBackendStatusResponse.make({
        source: "bilibili",
        available: true,
        qualities: [...BILIBILI_REGULAR_QUALITIES],
      });
    } catch (cause) {
      throw normalizeError(cause);
    }
  }

  async search(request: MusicSearchRequest, signal?: AbortSignal): Promise<MusicSearchResponse> {
    const dependencies = this.requireDependencies();
    try {
      const result = await dependencies.catalog.search(request.query, request.page ?? 1, signal);
      return MusicSearchResponse.make({
        total: result.total,
        tracks: result.tracks.map((track) =>
          MusicSearchTrack.make({
            bvid: track.bvid,
            title: track.title,
            artist: track.artist,
            durationSeconds: track.durationSeconds,
            pictureUrl: track.pictureUrl,
            qualities: [...BILIBILI_REGULAR_QUALITIES],
            reference: dependencies.tickets.issueTrack(track),
          }),
        ),
        nextPage: result.nextPage,
      });
    } catch (cause) {
      throw normalizeError(cause);
    }
  }

  async resolve(
    reference: string,
    quality: BilibiliAudioQuality,
    signal?: AbortSignal,
  ): Promise<MusicResolvedTrack> {
    const dependencies = this.requireDependencies();
    try {
      const track = await dependencies.tickets.verifyTrack(reference);
      const cid = track.cid ?? (await dependencies.catalog.firstPageCid(track.bvid, signal));
      const audio = await dependencies.playback.resolve(track.bvid, cid, quality, signal);
      const streamTicket = dependencies.tickets.issueStream(track.bvid, cid, quality);
      return MusicResolvedTrack.make({
        bvid: track.bvid,
        title: track.title,
        artist: track.artist,
        pictureUrl: track.pictureUrl,
        durationSeconds: track.durationSeconds,
        quality: audio.quality,
        url: `${BILIBILI_STREAM_PATH_PREFIX}${streamTicket}`,
      });
    } catch (cause) {
      throw normalizeError(cause);
    }
  }

  async stream(request: Request, token: string): Promise<Response> {
    const dependencies = this.requireDependencies();
    try {
      return await dependencies.streams.serve(request, token);
    } catch (cause) {
      throw normalizeError(cause);
    }
  }

  dispose(): Promise<void> {
    this.dependencies?.refresher?.dispose();
    return Promise.resolve();
  }

  private requireDependencies(): MusicBackendDependencies {
    if (this.dependencies === undefined) {
      throw musicBackendError("BACKEND_UNAVAILABLE", "Bilibili music backend is disabled");
    }
    return this.dependencies;
  }
}

function normalizeError(cause: unknown): ReturnType<typeof musicBackendError> {
  if (!isBilibiliError(cause)) {
    if (isMusicBackendError(cause)) return cause;
    return musicBackendError("BACKEND_UNAVAILABLE", "Bilibili music operation failed");
  }
  return musicBackendError(publicCode(cause), safeMessage(cause));
}

function publicCode(error: BilibiliError): MusicBackendErrorCode {
  switch (error.reason) {
    case "INVALID_CONFIG":
      return "BACKEND_UNAVAILABLE";
    case "INVALID_REQUEST":
      return "INVALID_REQUEST";
    case "AUTH_REQUIRED":
      return "AUTH_REQUIRED";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "RISK_CONTROLLED":
      return "RISK_CONTROLLED";
    case "NOT_FOUND":
      return "VIDEO_UNAVAILABLE";
    case "NO_AUDIO":
      return "AUDIO_UNAVAILABLE";
    case "TIMEOUT":
      return "TIMEOUT";
    case "POLICY_DENIED":
      return "POLICY_DENIED";
    case "UPSTREAM_FAILED":
    case "PROTOCOL_ERROR":
      return "UPSTREAM_FAILED";
  }
}

function safeMessage(error: BilibiliError): string {
  switch (error.reason) {
    case "AUTH_REQUIRED":
      return "Bilibili Cookie is expired or invalid";
    case "RATE_LIMITED":
    case "RISK_CONTROLLED":
      return "Bilibili temporarily rejected the request";
    case "NOT_FOUND":
      return "Bilibili video is unavailable";
    case "NO_AUDIO":
      return "Requested Bilibili audio quality is unavailable";
    case "TIMEOUT":
      return "Bilibili request timed out";
    default:
      return error.message;
  }
}
