import { describe, expect, it } from "vite-plus/test";
import { MusicSearchRequest } from "$lib/protocol";
import { MusicClient, MusicClientError, isMusicServerError } from "./music-client";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

const status = {
  source: "bilibili",
  available: true,
  qualities: ["64k", "132k", "192k"],
};

describe("music HTTP client", () => {
  it("validates status and search responses", async () => {
    const requests: Array<Request> = [];
    const client = new MusicClient("/status", "/search", async (input, init) => {
      const request = new Request(new URL(requestUrl(input), "https://snake.example"), init);
      requests.push(request);
      if (request.url.endsWith("/status")) return Response.json(status);
      return Response.json({
        total: 1,
        tracks: [
          {
            bvid: "BV1xx411c7mD",
            title: "Song",
            artist: "UP 主",
            durationSeconds: 180,
            pictureUrl: null,
            qualities: ["64k", "132k", "192k"],
            reference: "signed-reference-token-0123456789abcdef",
          },
        ],
      });
    });

    await expect(client.readStatus()).resolves.toEqual(status);
    await expect(
      client.search(MusicSearchRequest.make({ query: "Song" })),
    ).resolves.toMatchObject({ total: 1 });
    expect(requests[0]?.credentials).toBe("same-origin");
    expect(requests[1]?.method).toBe("POST");
    expect(requests[1]?.credentials).toBe("same-origin");
  });

  it("rejects removed premium quality values", async () => {
    const client = new MusicClient("/status", "/search", async () =>
      Response.json({ ...status, qualities: [...status.qualities, "hires"] }),
    );

    const error = await client.readStatus().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MusicClientError);
    if (!(error instanceof MusicClientError)) throw new Error("Expected MusicClientError");
    expect(error.stage).toBe("protocol");
  });

  it("surfaces stable server error codes", async () => {
    const client = new MusicClient("/status", "/search", async () =>
      Response.json({ error: "BACKEND_UNAVAILABLE" }, { status: 503 }),
    );

    const error = await client.readStatus().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MusicClientError);
    if (!(error instanceof MusicClientError)) throw new Error("Expected MusicClientError");
    expect(isMusicServerError(error, "BACKEND_UNAVAILABLE")).toBe(true);
  });

  it("rejects malformed successful responses as protocol errors", async () => {
    const client = new MusicClient("/status", "/search", async () => Response.json({ available: 1 }));

    const error = await client.readStatus().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MusicClientError);
    if (!(error instanceof MusicClientError)) throw new Error("Expected MusicClientError");
    expect(error.stage).toBe("protocol");
  });
});
