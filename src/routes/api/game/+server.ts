import type { RequestHandler } from "./$types";
import { BACKEND_DESCRIPTOR } from "$lib/server/room/room-settings";

export const GET: RequestHandler = () =>
  Response.json(BACKEND_DESCRIPTOR, {
    headers: { "cache-control": "public, max-age=300" },
  });
