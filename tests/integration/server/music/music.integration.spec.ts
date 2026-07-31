import { resolve } from "node:path";
import { expect, it } from "vite-plus/test";
import { ApiRouter } from "$lib/server/http/api-router";
import { MusicOutboundHttp } from "$lib/server/music/outbound-http";
import { MusicSourceService } from "$lib/server/music/service";
import { createBackendDescriptor, createRoomMetadata } from "$lib/server/room/room-settings";
import { loadRuntimeConfig } from "$lib/server/runtime/config";
import { RuntimeServices } from "$lib/server/runtime/services";

const sessionSecret = "test-session-signing-secret-at-least-32-characters";

it("serves root music status and resolves music only for authenticated sessions", async () => {
  const http = new MusicOutboundHttp(
    async () => Response.json({ url: "https://audio.example.test/song.mp3" }),
    async () => [{ address: "8.8.8.8", family: 4 }],
  );
  const music = await MusicSourceService.create({
    sourceFile: resolve("tests/fixtures/music-source/basic.js"),
    http,
    watch: false,
  });
  const room = createRoomMetadata([]);
  const services = new RuntimeServices(room, music);
  const config = loadRuntimeConfig({
    NODE_ENV: "development",
    SESSION_SIGNING_SECRET: sessionSecret,
  });
  const router = new ApiRouter(config, services, createBackendDescriptor(room));

  try {
    const status = await router.handle(new Request("https://snake.example/api/music"), "127.0.0.1");
    expect(status?.status).toBe(200);
    if (status === undefined) throw new Error("Expected music status response");
    expect((await status.json()).active.metadata.name).toBe("Fixture Source");

    const body = JSON.stringify({
      source: "kw",
      action: "musicUrl",
      info: { type: "320k", musicInfo: { hash: "song-hash" } },
    });
    const unauthorized = await router.handle(
      new Request("https://snake.example/api/music/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
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

    const resolved = await router.handle(
      new Request("https://snake.example/api/music/resolve", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookie ?? "" },
        body,
      }),
      "127.0.0.1",
    );
    expect(resolved?.status).toBe(200);
    expect(await resolved?.json()).toEqual({
      source: "kw",
      action: "musicUrl",
      data: { type: "320k", url: "https://audio.example.test/song.mp3" },
    });
  } finally {
    await services.dispose();
  }
});
