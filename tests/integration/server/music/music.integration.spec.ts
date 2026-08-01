import { expect, it } from "vite-plus/test";
import type { BilibiliFetch } from "$lib/server/music/bilibili/client";
import { BILIBILI_STREAM_PATH_PREFIX } from "$lib/server/music/bilibili/stream";
import { MusicBackendService } from "$lib/server/music/service";
import { ApiRouter } from "$lib/server/http/api-router";
import { createBackendDescriptor, createRoomMetadata } from "$lib/server/room/room-settings";
import { loadRuntimeConfig } from "$lib/server/runtime/config";
import { RuntimeServices } from "$lib/server/runtime/services";

const sessionSecret = "test-session-signing-secret-at-least-32-characters";
const bilibiliCookie =
  "SESSDATA=fake-session; DedeUserID=100; bili_jct=0123456789abcdef0123456789abcdef";
const bvid = "BV1xx411c7mD";

const bilibiliFetch: BilibiliFetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.pathname === "/x/web-interface/nav") {
    return Response.json({
      code: 0,
      data: {
        isLogin: true,
        wbi_img: {
          img_url: `https://i0.hdslb.com/bfs/wbi/${"a".repeat(32)}.png`,
          sub_url: `https://i0.hdslb.com/bfs/wbi/${"b".repeat(32)}.png`,
        },
      },
    });
  }
  if (url.pathname === "/x/web-interface/wbi/search/type") {
    return Response.json({
      code: 0,
      data: {
        numResults: 1,
        result: [
          {
            aid: 1,
            bvid,
            title: "Fixture Song",
            pic: "//i0.hdslb.com/fixture.jpg",
            author: "Fixture UP",
            duration: "03:00",
          },
        ],
      },
    });
  }
  if (url.pathname === "/x/player/pagelist") {
    return Response.json({ code: 0, data: [{ cid: 123 }] });
  }
  if (url.pathname === "/x/player/wbi/playurl") {
    return Response.json({
      code: 0,
      data: {
        dash: {
          audio: [
            {
              id: 30280,
              baseUrl:
                "https://upos-sz-mirrorali.bilivideo.com/audio.m4s?deadline=4102444800",
              backupUrl: [],
              mimeType: "audio/mp4",
            },
          ],
        },
      },
    });
  }
  if (url.hostname.endsWith(".bilivideo.com")) {
    return new Response(new Uint8Array([1, 2]), {
      status: request.headers.has("range") ? 206 : 200,
      headers: {
        "accept-ranges": "bytes",
        "content-length": "2",
        "content-range": "bytes 0-1/2",
        "content-type": "audio/mp4",
      },
    });
  }
  return new Response(null, { status: 404 });
};

it("serves Bilibili search and authenticated Range streaming", async () => {
  const music = await MusicBackendService.create({
    bilibiliCookie,
    signingSecret: sessionSecret,
    fetch: bilibiliFetch,
    now: () => 1_700_000_000_000,
  });
  const room = createRoomMetadata([]);
  const services = new RuntimeServices(room, music);
  const config = loadRuntimeConfig({
    NODE_ENV: "development",
    SESSION_SIGNING_SECRET: sessionSecret,
    BILIBILI_COOKIE: bilibiliCookie,
    BILIBILI_REFRESH_TOKEN: "0123456789abcdef0123456789abcdef",
  });
  const router = new ApiRouter(config, services, createBackendDescriptor(room));

  try {
    const unauthorizedStatus = await router.handle(
      new Request("https://snake.example/api/music"),
      "127.0.0.1",
    );
    expect(unauthorizedStatus?.status).toBe(401);

    const unauthorized = await router.handle(
      new Request("https://snake.example/api/music/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "Fixture" }),
      }),
      "127.0.0.1",
    );
    expect(unauthorized?.status).toBe(401);

    const login = await router.handle(
      new Request("https://snake.example/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname: "Music Tester" }),
      }),
      "127.0.0.1",
    );
    const cookie = login?.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toContain("serpentia_session=");

    const status = await router.handle(
      new Request("https://snake.example/api/music", {
        headers: { cookie: cookie ?? "" },
      }),
      "127.0.0.1",
    );
    expect(status?.status).toBe(200);
    expect(await status?.json()).toEqual({
      source: "bilibili",
      available: true,
      qualities: ["64k", "132k", "192k"],
    });

    const searched = await router.handle(
      new Request("https://snake.example/api/music/search", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookie ?? "" },
        body: JSON.stringify({ query: "Fixture" }),
      }),
      "127.0.0.1",
    );
    expect(searched?.status).toBe(200);
    const searchBody: unknown = await searched?.json();
    if (
      typeof searchBody !== "object" ||
      searchBody === null ||
      !("tracks" in searchBody) ||
      !Array.isArray(searchBody.tracks) ||
      searchBody.tracks.length === 0
    ) {
      throw new Error("Expected search result");
    }
    const track = searchBody.tracks[0];
    if (typeof track !== "object" || track === null || !("reference" in track) || typeof track.reference !== "string") {
      throw new Error("Expected signed track reference");
    }

    const resolved = await music.resolve(track.reference, "192k");
    expect(resolved.url.startsWith(BILIBILI_STREAM_PATH_PREFIX)).toBe(true);
    const stream = await router.handle(
      new Request(`https://snake.example${resolved.url}`, {
        headers: { cookie: cookie ?? "", range: "bytes=0-1" },
      }),
      "127.0.0.1",
    );
    expect(stream?.status).toBe(206);
    expect(stream?.headers.get("content-range")).toBe("bytes 0-1/2");
  } finally {
    await services.dispose();
  }
});
