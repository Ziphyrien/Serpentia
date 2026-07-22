import { Effect } from "effect";
import type { RequestHandler } from "./$types";
import { type TurnCredentialsErrorCode, type TurnCredentialsResponse } from "$lib/protocol";
import {
  SESSION_COOKIE_NAME,
  isSessionSigningSecretConfigured,
  verifySession,
} from "$lib/server/access/session";
import {
  isCloudflareTurnConfigured,
  requestCloudflareTurnCredentials,
} from "$lib/server/voice/cloudflare-turn";

export const POST: RequestHandler = async ({ cookies, platform }) => {
  const env = platform?.env;
  if (env === undefined) return turnError("RUNTIME_UNAVAILABLE", 503);
  if (!isSessionSigningSecretConfigured(env.SESSION_SIGNING_SECRET)) {
    return turnError("SERVER_MISCONFIGURED", 503);
  }

  const token = cookies.get(SESSION_COOKIE_NAME);
  const session =
    token === undefined ? undefined : await verifySession(token, env.SESSION_SIGNING_SECRET);
  if (session === undefined) return turnError("UNAUTHORIZED", 401);

  const config = {
    turnKeyId: env.TURN_KEY_ID,
    turnKeyApiToken: env.TURN_KEY_API_TOKEN,
  };
  if (!isCloudflareTurnConfigured(config)) {
    return turnError("SERVER_MISCONFIGURED", 503);
  }

  let rateLimitResponse: Response;
  try {
    rateLimitResponse = await env.GAME_ROOM.getByName("friends").fetch(
      new Request("https://internal/__turn-credential-attempt", {
        method: "POST",
        headers: { "x-serpentia-player-id": session.playerId },
      }),
    );
  } catch {
    return turnError("RUNTIME_UNAVAILABLE", 503);
  }
  if (rateLimitResponse.status === 429) {
    return turnError("RATE_LIMITED", 429, { "retry-after": "600" });
  }
  if (!rateLimitResponse.ok) return turnError("RUNTIME_UNAVAILABLE", 503);

  try {
    const credentials = await Effect.runPromise(
      requestCloudflareTurnCredentials(config, session.playerId),
    );
    return Response.json(credentials satisfies TurnCredentialsResponse, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch {
    return turnError("TURN_UNAVAILABLE", 503);
  }
};

function turnError(
  error: TurnCredentialsErrorCode,
  status: number,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "private, no-store");
  return Response.json({ error }, { status, headers: responseHeaders });
}
