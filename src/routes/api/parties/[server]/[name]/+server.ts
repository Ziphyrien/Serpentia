import {
  SESSION_COOKIE_NAME,
  isSessionSigningSecretConfigured,
  verifySession,
} from "$lib/server/access/session";
import { encodeNicknameHeader } from "$lib/server/room/connection-identity";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ cookies, request, params, platform }) => {
  if (params.server !== "game-room" || params.name !== "friends") {
    return new Response("Not found", { status: 404 });
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426 });
  }

  const env = platform?.env;
  if (!env) return new Response("Cloudflare runtime is required", { status: 503 });
  if (!isSessionSigningSecretConfigured(env.SESSION_SIGNING_SECRET)) {
    return new Response("Server is not configured", { status: 503 });
  }

  const token = cookies.get(SESSION_COOKIE_NAME);
  const session =
    token === undefined ? undefined : await verifySession(token, env.SESSION_SIGNING_SECRET);
  if (session === undefined) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }

  const headers = new Headers(request.headers);
  headers.delete("x-serpentia-player-id");
  headers.delete("x-serpentia-nickname");
  headers.delete("x-serpentia-session-expires-at");
  headers.set("x-serpentia-player-id", session.playerId);
  headers.set("x-serpentia-nickname", encodeNicknameHeader(session.nickname));
  headers.set("x-serpentia-session-expires-at", String(session.expiresAt));
  const authenticatedRequest = new Request(request, { headers });
  try {
    return await env.GAME_ROOM.getByName("friends").fetch(authenticatedRequest);
  } catch {
    return new Response("Game room is temporarily unavailable", { status: 503 });
  }
};
