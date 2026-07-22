import { SESSION_COOKIE_NAME, verifySession } from "$lib/server/access/session";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ cookies, request, params, platform }) => {
  if (params.server !== "game-room" || params.name !== "friends") {
    return new Response("Not found", { status: 404 });
  }

  const env = platform?.env;
  if (!env) return new Response("Cloudflare runtime is required", { status: 503 });

  const token = cookies.get(SESSION_COOKIE_NAME);
  const session = token === undefined
    ? undefined
    : await verifySession(token, env.SESSION_SIGNING_SECRET);
  if (session === undefined) return new Response("Unauthorized", { status: 401 });

  const headers = new Headers(request.headers);
  headers.delete("x-serpentia-player-id");
  headers.delete("x-serpentia-nickname");
  headers.set("x-serpentia-player-id", session.playerId);
  headers.set("x-serpentia-nickname", session.nickname);
  const authenticatedRequest = new Request(request, { headers });
  return env.GAME_ROOM.getByName("friends").fetch(authenticatedRequest);
};
