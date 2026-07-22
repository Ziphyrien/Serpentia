import { Effect, Schema } from "effect";
import {
  SessionRequest,
  type BackendDescriptor,
  type SessionErrorCode,
  type SessionStatus,
  type TurnCredentialsErrorCode,
  type TurnCredentialsResponse,
} from "../../protocol";
import { identifyPlayer, parseAccessKeyRegistry } from "../access/registry";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  SessionClaims,
  signSession,
  verifySession,
} from "../access/session";
import { normalizeNickname } from "../room/connection-identity";
import type { RuntimeConfig } from "../runtime/config";
import type { RuntimeServices } from "../runtime/services";
import { createCoturnCredentials } from "../voice/coturn";
import { readBoundedJson } from "./bounded-json";
import { expiredSessionCookie, readCookie, sessionCookie } from "./cookies";

const MAX_SESSION_BODY_BYTES = 2_048;

/** Bun HTTP 层使用的无框架 API 路由器。 */
export class ApiRouter {
  private readonly accessRegistry: ReadonlyMap<string, string>;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly services: RuntimeServices,
    private readonly descriptor: BackendDescriptor,
  ) {
    this.accessRegistry = Effect.runSync(parseAccessKeyRegistry(config.accessKeyHashes));
  }

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
      expiresAt: claims.expiresAt,
    });
  }

  private async createSession(request: Request, clientAddress: string): Promise<Response> {
    if (!isJsonRequest(request)) return sessionError("INVALID_REQUEST", 400);
    if (!this.services.accessAttempts.allow(clientAddress.slice(0, 128))) {
      return sessionError("RATE_LIMITED", 429);
    }

    let input: SessionRequest;
    try {
      const raw = await readBoundedJson(request, MAX_SESSION_BODY_BYTES);
      input = await Schema.decodeUnknownPromise(SessionRequest)(raw);
    } catch {
      return sessionError("INVALID_REQUEST", 400);
    }

    const nickname = normalizeNickname(input.nickname);
    if (nickname === undefined) return sessionError("INVALID_ACCESS", 401);

    let playerId: string | undefined;
    try {
      playerId = await identifyPlayer(input.key, this.accessRegistry);
    } catch {
      return sessionError("RUNTIME_UNAVAILABLE", 503);
    }
    if (playerId === undefined) return sessionError("INVALID_ACCESS", 401);

    const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1_000;
    const claims = SessionClaims.make({ playerId, nickname, expiresAt });
    let token: string;
    try {
      token = await signSession(claims, this.config.sessionSigningSecret);
    } catch {
      return sessionError("RUNTIME_UNAVAILABLE", 503);
    }

    return sessionJson(
      { authenticated: true, playerId, nickname, expiresAt },
      sessionCookie(token, SESSION_TTL_SECONDS, this.secureCookie(request)),
    );
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
    if (!this.services.turnCredentialAttempts.allow(session.playerId)) {
      return turnError("RATE_LIMITED", 429, { "retry-after": "600" });
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

function sessionError(error: SessionErrorCode, status: number): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

function sessionJson(status: SessionStatus, cookie?: string): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (cookie !== undefined) headers.set("set-cookie", cookie);
  return Response.json(status, { headers });
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
