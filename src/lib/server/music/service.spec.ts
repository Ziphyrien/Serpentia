import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { MusicSourceResolveRequest } from "../../protocol";
import { MusicOutboundHttp } from "./outbound-http";
import { MusicSourceService } from "./service";

const fixturePath = resolve("tests/fixtures/music-source/basic.js");
const rootSourcePath = resolve("music-source.js");
const publicLookup = async () => [{ address: "8.8.8.8", family: 4 }];

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function makeHttp(requests: Array<string>): MusicOutboundHttp {
  return new MusicOutboundHttp(async (input) => {
    const url = requestUrl(input);
    requests.push(url);
    if (url.includes("/script?")) return Response.json({ code: 2, data: null });
    if (url.includes("music.example.test")) {
      return Response.json({ url: "https://audio.example.test/fixture.mp3" });
    }
    return Response.json({ code: 0, data: "https://audio.example.test/root.mp3" });
  }, publicLookup);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

describe("root LX music source service", () => {
  it("executes the LX bridge, filters capabilities, and normalizes all result actions", async () => {
    const requests: Array<string> = [];
    const service = await MusicSourceService.create({
      sourceFile: fixturePath,
      http: makeHttp(requests),
      watch: false,
    });

    try {
      await waitFor(() => service.status().update?.log === "Fixture update");
      const status = service.status();
      expect(status.active?.metadata.name).toBe("Fixture Source");
      expect(status.update?.log).toBe("Fixture update");
      expect(status.active?.sources).toEqual([
        {
          source: "kw",
          name: "Kuwo",
          type: "music",
          actions: ["musicUrl"],
          qualitys: ["128k", "320k"],
        },
        {
          source: "local",
          name: "Local",
          type: "music",
          actions: ["musicUrl", "pic", "lyric"],
          qualitys: [],
        },
      ]);

      const music = await service.resolve(
        MusicSourceResolveRequest.make({
          source: "kw",
          action: "musicUrl",
          info: { type: "320k", musicInfo: { hash: "song-hash" } },
        }),
      );
      expect(music).toEqual({
        source: "kw",
        action: "musicUrl",
        data: { type: "320k", url: "https://audio.example.test/fixture.mp3" },
      });

      const picture = await service.resolve(
        MusicSourceResolveRequest.make({
          source: "local",
          action: "pic",
          info: { musicInfo: { hash: "local-song" } },
        }),
      );
      expect(picture).toEqual({
        source: "local",
        action: "pic",
        data: "https://cdn.example.test/cover.jpg",
      });

      const lyric = await service.resolve(
        MusicSourceResolveRequest.make({
          source: "local",
          action: "lyric",
          info: { musicInfo: { hash: "local-song" } },
        }),
      );
      expect(lyric).toEqual({
        source: "local",
        action: "lyric",
        data: {
          lyric: "[00:00.00]Fixture",
          tlyric: null,
          rlyric: null,
          lxlyric: null,
        },
      });
      expect(requests[0]).toContain("music.example.test/url/kw/song-hash/320k");
    } finally {
      await service.dispose();
    }
  });

  it("atomically replaces a running source when the root file changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "serpentia-music-"));
    const sourceFile = join(directory, "music-source.js");
    const fixture = await readFile(fixturePath, "utf8");
    await writeFile(sourceFile, fixture);
    const service = await MusicSourceService.create({
      sourceFile,
      http: makeHttp([]),
      watch: false,
    });

    try {
      expect(service.status().active?.metadata.name).toBe("Fixture Source");
      await writeFile(sourceFile, fixture.replace("Fixture Source", "Reloaded Source"));
      await service.reload();
      expect(service.status().active?.metadata.name).toBe("Reloaded Source");
    } finally {
      await service.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(existsSync(rootSourcePath))(
    "executes the local encrypted or obfuscated music-source.js without network access",
    async () => {
      const requests: Array<string> = [];
      const service = await MusicSourceService.create({
        sourceFile: rootSourcePath,
        http: makeHttp(requests),
        watch: false,
      });
      try {
        expect(service.status().active?.sources.some((source) => source.source === "local")).toBe(
          true,
        );
        const result = await service.resolve(
          MusicSourceResolveRequest.make({
            source: "kw",
            action: "musicUrl",
            info: {
              type: "320k",
              musicInfo: { source: "kw", songmid: "song-mid", hash: "probe-hash" },
            },
          }),
        );
        expect(result.action).toBe("musicUrl");
        expect(
          requests.some((url) => url.includes("/lxmusicv4/url/kw/probe-hash/320k?sign=")),
        ).toBe(true);
      } finally {
        await service.dispose();
      }
    },
  );
});
