import { Effect, Schema } from "effect";
import type { RequestHandler } from "./$types";
import { identifyPlayer, parseAccessKeyRegistry } from "$lib/server/access/registry";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  SessionClaims,
  signSession,
} from "$lib/server/access/session";
import { normalizeNickname } from "$lib/server/room/connection-identity";

const SessionRequest = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  nickname: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});

export const POST: RequestHandler = async ({ cookies, platform, request }) => {
  const env = platform?.env;
  if (!env) return Response.json({ error: "RUNTIME_UNAVAILABLE" }, { status: 503 });

  try {
    const source = request.headers.get("cf-connecting-ip") ?? "local";
    const rateLimitResponse = await env.GAME_ROOM.getByName("friends").fetch(
      new Request("https://internal/__access-attempt", {
        method: "POST",
        headers: { "x-serpentia-source": source },
      }),
    );
    if (!rateLimitResponse.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

    const raw: unknown = await request.json();
    const input = await Schema.decodeUnknownPromise(SessionRequest)(raw);
    const nickname = normalizeNickname(input.nickname);
    if (nickname === undefined) return unauthorized();

    const registry = await Effect.runPromise(parseAccessKeyRegistry(env.ACCESS_KEY_HASHES));
    const playerId = await identifyPlayer(input.key, registry);
    if (playerId === undefined) return unauthorized();

    const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1_000;
    const claims = new SessionClaims({ playerId, nickname, expiresAt });
    const token = await signSession(claims, env.SESSION_SIGNING_SECRET);
    cookies.set(SESSION_COOKIE_NAME, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: new URL(request.url).protocol === "https:",
      maxAge: SESSION_TTL_SECONDS,
    });
    return Response.json({ playerId, nickname, expiresAt });
  } catch {
    return unauthorized();
  }
};

function unauthorized(): Response {
  return Response.json({ error: "INVALID_ACCESS" }, { status: 401 });
}
