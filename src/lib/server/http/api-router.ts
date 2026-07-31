import { Schema } from "effect";
import {
  MusicSourceResolveRequest,
  SessionRequest,
  type BackendDescriptor,
  type MusicSourceErrorCode,
  type SessionErrorCode,
  type SessionStatus,
  type TurnCredentialsErrorCode,
  type TurnCredentialsResponse,
} from "../../protocol";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  SessionClaims,
  signSession,
  verifySession,
} from "../access/session";
import { isMusicSourceError } from "../music/errors";
import { normalizeNickname, normalizeSkinId } from "../room/connection-identity";
import type { RuntimeConfig } from "../runtime/config";
import type { RuntimeServices } from "../runtime/services";
import { createCoturnCredentials } from "../voice/coturn";
import { readBoundedJson } from "./bounded-json";
import { expiredSessionCookie, readCookie, sessionCookie } from "./cookies";

const MAX_SESSION_BODY_BYTES = 2_048;
const MAX_MUSIC_BODY_BYTES = 16_384;

export class ApiRouter {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly services: RuntimeServices,
    private readonly descriptor: BackendDescriptor,
  ) {}

  async handle(request: Request, clientAddress: string): Promise<Response | undefined> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/healthz") {
      return new Response("ok\n", {
        status: 200,
        headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (pathname === "/api/game") {
      return request.method === "GET"
        ? Response.json(this.descriptor, { headers: { "cache-control": "public, max-age=300" } })
        : methodNotAllowed("GET");
    }
    if (pathname === this.descriptor.sessionPath) return this.handleSession(request, clientAddress);
    if (pathname === this.descriptor.turnCredentialsPath) {
      return this.handleTurnCredentials(request);
    }
    if (pathname === this.descriptor.musicPath) return this.handleMusicStatus(request);
    if (pathname === this.descriptor.musicResolvePath) return this.handleMusicResolve(request);
    if (pathname === this.descriptor.websocketPath) {
      return new Response("WebSocket upgrade required", {
        status: 426,
        headers: { upgrade: "websocket" },
      });
    }
    if (pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return undefined;
  }

  private async handleSession(request: Request, clientAddress: string): Promise<Response> {
    if (request.method === "GET") return this.readSession(request);
    if (request.method === "POST") return this.createSession(request, clientAddress);
    if (request.method === "DELETE") {
      const token = readCookie(request, SESSION_COOKIE_NAME);
      const claims =
        token === undefined
          ? undefined
          : await verifySession(token, this.config.sessionSigningSecret);
      if (claims !== undefined) this.services.gameRoom.release(claims.playerId);

      return new Response(null, {
        status: 204,
        headers: {
          "cache-control": "no-store",
          "set-cookie": expiredSessionCookie(this.secureCookie(request)),
        },
      });
    }
    return methodNotAllowed("GET, POST, DELETE");
  }

  private async readSession(request: Request): Promise<Response> {
    const token = readCookie(request, SESSION_COOKIE_NAME);
    const claims =
      token === undefined
        ? undefined
        : await verifySession(token, this.config.sessionSigningSecret);
    if (claims === undefined) {
      return sessionJson(
        { authenticated: false },
        token === undefined ? undefined : expiredSessionCookie(this.secureCookie(request)),
      );
    }
    return sessionJson({
      authenticated: true,
      playerId: claims.playerId,
      nickname: claims.nickname,
      skinId: claims.skinId,
      expiresAt: claims.expiresAt,
    });
  }

  private async createSession(request: Request, clientAddress: string): Promise<Response> {
    if (!isJsonRequest(request)) return sessionError("INVALID_REQUEST", 400);
    const sessionAttempt = this.services.sessionAttempts.take(clientAddress.slice(0, 128));
    if (!sessionAttempt.allowed) {
      return sessionError("RATE_LIMITED", 429, retryAfterHeaders(sessionAttempt));
    }

    let input: SessionRequest;
    try {
      const raw = await readBoundedJson(request, MAX_SESSION_BODY_BYTES);
      input = await Schema.decodeUnknownPromise(SessionRequest)(raw);
    } catch {
      return sessionError("INVALID_REQUEST", 400);
    }

    const nickname = normalizeNickname(input.nickname);
    if (nickname === undefined) return sessionError("INVALID_REQUEST", 400);

    const skinId = normalizeSkinId(input.skinId);
    try {
      const playerId = crypto.randomUUID();
      const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1_000;
      const claims = SessionClaims.make({ playerId, nickname, skinId, expiresAt });
      const token = await signSession(claims, this.config.sessionSigningSecret);
      return sessionJson(
        { authenticated: true, playerId, nickname, skinId, expiresAt },
        sessionCookie(token, SESSION_TTL_SECONDS, this.secureCookie(request)),
      );
    } catch {
      return sessionError("RUNTIME_UNAVAILABLE", 503);
    }
  }

  private async handleTurnCredentials(request: Request): Promise<Response> {
    if (request.method !== "POST") return methodNotAllowed("POST");

    const token = readCookie(request, SESSION_COOKIE_NAME);
    const session =
      token === undefined
        ? undefined
        : await verifySession(token, this.config.sessionSigningSecret);
    if (session === undefined) return turnError("UNAUTHORIZED", 401);
    if (this.config.coturn === undefined) return turnError("SERVER_MISCONFIGURED", 503);
    const turnAttempt = this.services.turnCredentialAttempts.take(session.playerId);
    if (!turnAttempt.allowed) {
      return turnError("RATE_LIMITED", 429, retryAfterHeaders(turnAttempt));
    }

    try {
      const credentials = await createCoturnCredentials(this.config.coturn, session.playerId);
      return Response.json(credentials satisfies TurnCredentialsResponse, {
        headers: { "cache-control": "private, no-store" },
      });
    } catch {
      return turnError("TURN_UNAVAILABLE", 503);
    }
  }

  private handleMusicStatus(request: Request): Response {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return Response.json(this.services.music.status(), {
      headers: { "cache-control": "public, max-age=5" },
    });
  }

  private async handleMusicResolve(request: Request): Promise<Response> {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const token = readCookie(request, SESSION_COOKIE_NAME);
    const session =
      token === undefined
        ? undefined
        : await verifySession(token, this.config.sessionSigningSecret);
    if (session === undefined) return musicError("UNAUTHORIZED", 401);
    const attempt = this.services.musicResolveAttempts.take(session.playerId);
    if (!attempt.allowed) {
      return musicError("RATE_LIMITED", 429, retryAfterHeaders(attempt));
    }
    if (!isJsonRequest(request)) return musicError("INVALID_REQUEST", 400);

    let input: MusicSourceResolveRequest;
    try {
      const raw = await readBoundedJson(request, MAX_MUSIC_BODY_BYTES);
      input = await Schema.decodeUnknownPromise(MusicSourceResolveRequest)(raw);
    } catch {
      return musicError("INVALID_REQUEST", 400);
    }

    try {
      const result = await this.services.music.resolve(input, request.signal);
      return Response.json(result, {
        headers: { "cache-control": "private, no-store" },
      });
    } catch (cause) {
      if (!isMusicSourceError(cause)) return musicError("RUNTIME_UNAVAILABLE", 503);
      return musicError(cause.code, musicStatus(cause.code));
    }
  }

  private secureCookie(request: Request): boolean {
    if (this.config.cookieSecure) return true;
    const url = new URL(request.url);
    if (url.protocol === "https:") return true;
    return (
      this.config.trustProxy &&
      request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https"
    );
  }
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim() === "application/json";
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method not allowed", { status: 405, headers: { allow } });
}

function sessionError(
  error: SessionErrorCode,
  status: number,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  return Response.json({ error }, { status, headers: responseHeaders });
}

function sessionJson(status: SessionStatus, cookie?: string): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (cookie !== undefined) headers.set("set-cookie", cookie);
  return Response.json(status, { headers });
}

function retryAfterHeaders(decision: { readonly retryAfterMilliseconds: number }): HeadersInit {
  return {
    "retry-after": String(Math.max(1, Math.ceil(decision.retryAfterMilliseconds / 1000))),
  };
}

function musicStatus(error: MusicSourceErrorCode): number {
  switch (error) {
    case "INVALID_REQUEST":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "RATE_LIMITED":
      return 429;
    case "UPSTREAM_FAILED":
    case "POLICY_DENIED":
      return 502;
    case "TIMEOUT":
      return 504;
    case "SOURCE_UNAVAILABLE":
    case "INITIALIZATION_FAILED":
    case "RUNTIME_UNAVAILABLE":
      return 503;
  }
}

function musicError(
  error: MusicSourceErrorCode,
  status: number,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "private, no-store");
  return Response.json({ error }, { status, headers: responseHeaders });
}

function turnError(
  error: TurnCredentialsErrorCode,
  status: number,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "private, no-store");
  return Response.json({ error }, { status, headers: responseHeaders });
}
