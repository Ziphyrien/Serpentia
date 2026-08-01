import { describe, expect, it } from "vite-plus/test";
import type { BilibiliFetch } from "./bilibili/client";
import { BILIBILI_STREAM_PATH_PREFIX } from "./bilibili/stream";
import { MusicBackendService } from "./service";

const cookie = "SESSDATA=fake-session; DedeUserID=100";
const signingSecret = "test-bilibili-ticket-secret-at-least-32-characters";
const bvid = "BV1xx411c7mD";
const mediaUrl =
  "https://upos-sz-mirrorali.bilivideo.com/audio.m4s?deadline=4102444800";

interface RecordedRequest {
  readonly url: string;
  readonly cookie: string | null;
  readonly range: string | null;
}

function makeFetcher(
  requests: Array<RecordedRequest>,
  backupUrls: ReadonlyArray<string> = [],
  searchResponse?: (url: URL) => unknown,
): BilibiliFetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({
      url: url.href,
      cookie: request.headers.get("cookie"),
      range: request.headers.get("range"),
    });
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
      if (searchResponse !== undefined) return Response.json(searchResponse(url));
      return Response.json({
        code: 0,
        data: {
          numResults: 1,
          result: [
            {
              aid: 1,
              bvid,
              title: '<em class="keyword">Fixture &amp; Song</em>',
              pic: "//i0.hdslb.com/bfs/archive/fixture.jpg",
              author: "Fixture UP",
              duration: "03:00",
              typeid: "130",
            },
            {
              aid: 0,
              bvid: "",
              title: "Non-video search card",
              pic: "",
              author: "",
              duration: "00:00",
              typeid: "0",
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
              { id: 30216, baseUrl: mediaUrl, backupUrl: [], mimeType: "audio/mp4" },
              { id: 30232, baseUrl: mediaUrl, backupUrl: [], mimeType: "audio/mp4" },
              { id: 30280, baseUrl: mediaUrl, backupUrl: [...backupUrls], mimeType: "audio/mp4" }
            ],
          },
        },
      });
    }
    if (url.hostname.endsWith(".bilivideo.com")) {
      const range = request.headers.get("range");
      return new Response(new Uint8Array([1, 2]), {
        status: range === null ? 200 : 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": "2",
          "content-range": "bytes 0-1/2",
          "content-type": "audio/mp4",
        },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

describe("Bilibili music backend", () => {
  it("searches, resolves signed references, and proxies Range requests", async () => {
    const requests: Array<RecordedRequest> = [];
    const service = await MusicBackendService.create({
      bilibiliCookie: cookie,
      signingSecret,
      fetch: makeFetcher(requests),
      now: () => 1_700_000_000_000,
    });

    expect(await service.status()).toEqual({
      source: "bilibili",
      available: true,
      qualities: ["64k", "132k", "192k"],
    });

    const searched = await service.search({ query: "Fixture" });
    expect(searched).toMatchObject({
      total: 1,
      tracks: [
        {
          bvid,
          title: "Fixture & Song",
          artist: "Fixture UP",
          durationSeconds: 180,
          pictureUrl: "https://i0.hdslb.com/bfs/archive/fixture.jpg",
          qualities: ["64k", "132k", "192k"],
        },
      ],
    });

    const track = searched.tracks[0];
    if (track === undefined) throw new Error("Expected search track");
    const resolved = await service.resolve(track.reference, "192k");
    expect(resolved).toMatchObject({
      bvid,
      title: "Fixture & Song",
      quality: "192k",
    });
    expect(resolved.url.startsWith(BILIBILI_STREAM_PATH_PREFIX)).toBe(true);
    const token = resolved.url.slice(BILIBILI_STREAM_PATH_PREFIX.length);
    const streamed = await service.stream(
      new Request(`https://snake.example${resolved.url}`, {
        headers: { range: "bytes=0-1" },
      }),
      token,
    );
    expect(streamed.status).toBe(206);
    expect(streamed.headers.get("content-length")).toBeNull();
    expect(new Uint8Array(await streamed.arrayBuffer())).toEqual(new Uint8Array([1, 2]));

    const head = await service.stream(
      new Request(`https://snake.example${resolved.url}`, {
        method: "HEAD",
        headers: { range: "bytes=0-1" },
      }),
      token,
    );
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("2");

    const apiRequests = requests.filter((request) => request.url.includes("api.bilibili.com"));
    expect(apiRequests.every((request) => request.cookie === cookie)).toBe(true);
    expect(requests.find((request) => request.url === mediaUrl)?.cookie).toBeNull();
    expect(requests.find((request) => request.url === mediaUrl)?.range).toBe("bytes=0-1");
  });

  it("returns one search page with the next-page cursor", async () => {
    const requests: Array<RecordedRequest> = [];
    const videos = Array.from({ length: 45 }, (_, index) => ({
      aid: index + 1,
      bvid: `BV${String(index + 1).padStart(10, "0")}`,
      title: `Fixture ${index + 1}`,
      pic: `//i0.hdslb.com/bfs/archive/fixture-${index + 1}.jpg`,
      author: "Fixture UP",
      duration: "03:00",
      typeid: "130",
    }));
    const service = MusicBackendService.create({
      bilibiliCookie: cookie,
      signingSecret,
      fetch: makeFetcher(requests, [], (url) => {
        const page = Number(url.searchParams.get("page") ?? "1");
        const start = (page - 1) * 20;
        return {
          code: 0,
          data: {
            numResults: videos.length,
            numPages: 3,
            result: videos.slice(start, start + 20),
          },
        };
      }),
      now: () => 1_700_000_000_000,
    });

    const first = await service.search({ query: "Fixture", page: 1 });
    const second = await service.search({ query: "Fixture", page: 2 });
    const third = await service.search({ query: "Fixture", page: 3 });
    expect(first.tracks).toHaveLength(20);
    expect(first.nextPage).toBe(2);
    expect(second.tracks).toHaveLength(20);
    expect(second.nextPage).toBe(3);
    expect(third.tracks).toHaveLength(5);
    expect(third.nextPage).toBeNull();
    expect([...first.tracks, ...second.tracks, ...third.tracks].map((track) => track.bvid)).toEqual(
      videos.map((video) => video.bvid),
    );
    const searchRequests = requests
      .map((request) => new URL(request.url))
      .filter((url) => url.pathname === "/x/web-interface/wbi/search/type");
    expect(searchRequests.map((url) => url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(searchRequests.every((url) => url.searchParams.get("page_size") === "20")).toBe(true);
  });

  it("moves to a backup CDN when the primary response headers time out", async () => {
    const backupUrl = "https://backup.bilivideo.com/audio.m4s?deadline=4102444800";
    const fallback = makeFetcher([], [backupUrl]);
    const fetcher: BilibiliFetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url === mediaUrl) {
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        });
      }
      return fallback(input, init);
    };
    const service = MusicBackendService.create({
      bilibiliCookie: cookie,
      signingSecret,
      fetch: fetcher,
      now: () => 1_700_000_000_000,
      mediaHeaderTimeoutMilliseconds: 1,
    });
    const searched = await service.search({ query: "Fixture" });
    const reference = searched.tracks[0]?.reference;
    if (reference === undefined) throw new Error("Expected search track");
    const resolved = await service.resolve(reference, "192k");
    const response = await service.stream(
      new Request(`https://snake.example${resolved.url}`, { headers: { range: "bytes=0-1" } }),
      resolved.url.slice(BILIBILI_STREAM_PATH_PREFIX.length),
    );
    expect(response.status).toBe(206);
  });

  it("reports the actual downgraded quality and reuses it through the stream proxy", async () => {
    const requests: Array<RecordedRequest> = [];
    const baseFetcher = makeFetcher(requests);
    const fallbackMediaUrl =
      "https://upos-sz-mirrorali.bilivideo.com/audio-132.m4s?deadline=4102444800";
    const fetcher: BilibiliFetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname !== "/x/player/wbi/playurl") return baseFetcher(input, init);
      requests.push({
        url: url.href,
        cookie: request.headers.get("cookie"),
        range: request.headers.get("range"),
      });
      return Response.json({
        code: 0,
        data: {
          dash: {
            audio: [
              {
                id: 30232,
                baseUrl: fallbackMediaUrl,
                backupUrl: [],
                mimeType: "audio/mp4",
              },
            ],
          },
        },
      });
    };
    const service = MusicBackendService.create({
      bilibiliCookie: cookie,
      signingSecret,
      fetch: fetcher,
      now: () => 1_700_000_000_000,
    });

    const searched = await service.search({ query: "Fixture" });
    const reference = searched.tracks[0]?.reference;
    if (reference === undefined) throw new Error("Expected search track");
    const resolved = await service.resolve(reference, "192k");
    expect(resolved.quality).toBe("132k");

    const streamed = await service.stream(
      new Request(`https://snake.example${resolved.url}`, { headers: { range: "bytes=0-1" } }),
      resolved.url.slice(BILIBILI_STREAM_PATH_PREFIX.length),
    );
    expect(streamed.status).toBe(206);
    expect(requests.filter((request) => request.url.includes("/x/player/wbi/playurl"))).toHaveLength(
      1,
    );
  });

  it("rejects a tampered client reference", async () => {
    const service = await MusicBackendService.create({
      bilibiliCookie: cookie,
      signingSecret,
      fetch: makeFetcher([]),
    });
    await expect(
      service.resolve(`${"a".repeat(40)}.${"b".repeat(40)}`, "132k"),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
