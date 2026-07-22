import { Effect, Schema } from "effect";
import type { RequestHandler } from "./$types";
import { SessionRequest, type SessionErrorCode, type SessionStatus } from "$lib/protocol";
import { identifyPlayer, parseAccessKeyRegistry } from "$lib/server/access/registry";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  SessionClaims,
  isSessionSigningSecretConfigured,
  signSession,
  verifySession,
} from "$lib/server/access/session";
import { readBoundedJson } from "$lib/server/http/bounded-json";
import { normalizeNickname } from "$lib/server/room/connection-identity";

const MAX_SESSION_BODY_BYTES = 2_048;

export const GET: RequestHandler = async ({ cookies, platform }) => {
  const env = platform?.env;
  if (env === undefined) return sessionError("RUNTIME_UNAVAILABLE", 503);
  if (!isSessionSigningSecretConfigured(env.SESSION_SIGNING_SECRET)) {
    return sessionError("SERVER_MISCONFIGURED", 503);
  }

  const token = cookies.get(SESSION_COOKIE_NAME);
  const claims =
    token === undefined ? undefined : await verifySession(token, env.SESSION_SIGNING_SECRET);
  if (claims === undefined) {
    if (token !== undefined) clearSessionCookie(cookies);
    return sessionJson({ authenticated: false } satisfies SessionStatus);
  }
  return sessionJson({
    authenticated: true,
    playerId: claims.playerId,
    nickname: claims.nickname,
    expiresAt: claims.expiresAt,
  } satisfies SessionStatus);
};

export const POST: RequestHandler = async ({ cookies, platform, request }) => {
  const env = platform?.env;
  if (env === undefined) return sessionError("RUNTIME_UNAVAILABLE", 503);
  if (
    !isSessionSigningSecretConfigured(env.SESSION_SIGNING_SECRET) ||
    typeof env.ACCESS_KEY_HASHES !== "string"
  ) {
    return sessionError("SERVER_MISCONFIGURED", 503);
  }
  if (!isJsonRequest(request)) return sessionError("INVALID_REQUEST", 400);

  const source = (request.headers.get("cf-connecting-ip") ?? "local").slice(0, 128);
  let rateLimitResponse: Response;
  try {
    rateLimitResponse = await env.GAME_ROOM.getByName("friends").fetch(
      new Request("https://internal/__access-attempt", {
        method: "POST",
        headers: { "x-serpentia-source": source },
      }),
    );
  } catch {
    return sessionError("RUNTIME_UNAVAILABLE", 503);
  }
  if (!rateLimitResponse.ok) return sessionError("RATE_LIMITED", 429);

  let input: SessionRequest;
  try {
    const raw = await readBoundedJson(request, MAX_SESSION_BODY_BYTES);
    input = await Schema.decodeUnknownPromise(SessionRequest)(raw);
  } catch {
    return sessionError("INVALID_REQUEST", 400);
  }

  const nickname = normalizeNickname(input.nickname);
  if (nickname === undefined) return sessionError("INVALID_ACCESS", 401);

  let registry: ReadonlyMap<string, string>;
  try {
    registry = await Effect.runPromise(parseAccessKeyRegistry(env.ACCESS_KEY_HASHES));
  } catch {
    return sessionError("SERVER_MISCONFIGURED", 503);
  }
  let playerId: string | undefined;
  try {
    playerId = await identifyPlayer(input.key, registry);
  } catch {
    return sessionError("RUNTIME_UNAVAILABLE", 503);
  }
  if (playerId === undefined) return sessionError("INVALID_ACCESS", 401);

  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1_000;
  const claims = SessionClaims.make({ playerId, nickname, expiresAt });
  let token: string;
  try {
    token = await signSession(claims, env.SESSION_SIGNING_SECRET);
  } catch {
    return sessionError("RUNTIME_UNAVAILABLE", 503);
  }
  cookies.set(SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: new URL(request.url).protocol === "https:",
    maxAge: SESSION_TTL_SECONDS,
  });
  return sessionJson({
    authenticated: true,
    playerId,
    nickname,
    expiresAt,
  } satisfies SessionStatus);
};

export const DELETE: RequestHandler = ({ cookies }) => {
  clearSessionCookie(cookies);
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
};

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim() === "application/json";
}

function clearSessionCookie(cookies: Parameters<RequestHandler>[0]["cookies"]): void {
  cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
}

function sessionError(error: SessionErrorCode, status: number): Response {
  return Response.json(
    { error },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
  );
}

function sessionJson(status: SessionStatus): Response {
  return Response.json(status, { headers: { "cache-control": "no-store" } });
}
