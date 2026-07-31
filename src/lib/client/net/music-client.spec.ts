import { describe, expect, it } from "vite-plus/test";
import { MusicSearchRequest, MusicSourceResolveRequest } from "$lib/protocol";
import { MusicClient, MusicClientError, isMusicServerError } from "./music-client";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

const status = {
  active: {
    metadata: {
      name: "Fixture",
      description: "",
      author: "",
      homepage: "",
      version: "1",
      digest: "a".repeat(64),
    },
    sources: [
      {
        source: "kw",
        name: "kw",
        type: "music",
        actions: ["musicUrl"],
        qualitys: ["320k"],
      },
    ],
  },
  update: null,
};

describe("music HTTP client", () => {
  it("validates status and resolve responses", async () => {
    const requests: Array<Request> = [];
    const client = new MusicClient("/status", "/search", "/resolve", async (input, init) => {
      const request = new Request(new URL(requestUrl(input), "https://snake.example"), init);
      requests.push(request);
      if (request.url.endsWith("/status")) return Response.json(status);
      if (request.url.endsWith("/search")) {
        return Response.json({
          source: "kw",
          total: 1,
          tracks: [
            {
              id: "kw_song",
              source: "kw",
              title: "Song",
              artist: "Artist",
              album: "Album",
              durationSeconds: 180,
              qualitys: ["320k"],
              musicInfo: { id: "kw_song", source: "kw" },
            },
          ],
        });
      }
      return Response.json({
        source: "kw",
        action: "musicUrl",
        data: { type: "320k", url: "https://audio.example/song.mp3" },
      });
    });

    await expect(client.readStatus()).resolves.toEqual(status);
    await expect(
      client.search(MusicSearchRequest.make({ source: "kw", query: "Song" })),
    ).resolves.toMatchObject({ source: "kw", total: 1 });
    await expect(
      client.resolve(
        MusicSourceResolveRequest.make({
          source: "kw",
          action: "musicUrl",
          info: { type: "320k", musicInfo: { hash: "song" } },
        }),
      ),
    ).resolves.toMatchObject({ action: "musicUrl" });
    expect(requests[1]?.method).toBe("POST");
    expect(requests[1]?.credentials).toBe("same-origin");
    expect(requests[2]?.method).toBe("POST");
    expect(requests[2]?.credentials).toBe("same-origin");
  });

  it("surfaces stable server error codes", async () => {
    const client = new MusicClient("/status", "/search", "/resolve", async () =>
      Response.json({ error: "SOURCE_UNAVAILABLE" }, { status: 503 }),
    );

    const error = await client.readStatus().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MusicClientError);
    if (!(error instanceof MusicClientError)) throw new Error("Expected MusicClientError");
    expect(isMusicServerError(error, "SOURCE_UNAVAILABLE")).toBe(true);
  });

  it("rejects malformed successful responses as protocol errors", async () => {
    const client = new MusicClient("/status", "/search", "/resolve", async () => Response.json({ active: 1 }));

    const error = await client.readStatus().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MusicClientError);
    if (!(error instanceof MusicClientError)) throw new Error("Expected MusicClientError");
    expect(error.stage).toBe("protocol");
  });
});
