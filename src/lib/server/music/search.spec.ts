import { describe, expect, it } from "vite-plus/test";
import { MusicSearchRequest, type MusicSourcePlatform } from "$lib/protocol";
import { MusicOutboundHttp, type MusicFetch } from "./outbound-http";
import { MusicSearchService } from "./search";

const fetcher: MusicFetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  switch (url.hostname) {
    case "search.kuwo.cn":
      return Response.json({
        TOTAL: "1",
        SHOW: "1",
        abslist: [
          {
            MUSICRID: "MUSIC_101",
            SONGNAME: "Kuwo Song",
            ARTIST: "Singer",
            ALBUM: "Album",
            ALBUMID: "11",
            DURATION: "180",
            N_MINFO:
              "level:p,bitrate:128,format:mp3,size:3.0M;level:h,bitrate:320,format:mp3,size:7.0M",
          },
        ],
      });
    case "songsearch.kugou.com":
      return Response.json({
        error_code: 0,
        data: {
          total: 1,
          lists: [
            {
              Audioid: 202,
              SongName: "Kugou Song",
              AlbumName: "Album",
              AlbumID: "22",
              Duration: 181,
              Singers: [{ name: "Singer" }],
              FileSize: 3_000_000,
              FileHash: "kg-128",
              HQFileSize: 7_000_000,
              HQFileHash: "kg-320",
              SQFileSize: 0,
              SQFileHash: "",
              ResFileSize: 0,
              ResFileHash: "",
              Grp: [],
            },
          ],
        },
      });
    case "u.y.qq.com":
      return Response.json({
        code: 0,
        req: {
          code: 0,
          data: {
            body: {
              item_song: [
                {
                  id: 303,
                  mid: "tx-song-mid",
                  title: "Tencent Song",
                  interval: 182,
                  singer: [{ name: "Singer" }],
                  album: { name: "Album", mid: "tx-album-mid" },
                  file: {
                    media_mid: "tx-media-mid",
                    size_128mp3: 3_000_000,
                    size_320mp3: 7_000_000,
                    size_flac: 0,
                    size_hires: 0,
                  },
                },
              ],
            },
            meta: { estimate_sum: 1 },
          },
        },
      });
    case "interface.music.163.com":
      return Response.json({
        code: 200,
        data: {
          totalCount: 1,
          resources: [
            {
              baseInfo: {
                simpleSongData: {
                  id: 404,
                  name: "Netease Song",
                  dt: 183_000,
                  ar: [{ name: "Singer" }],
                  al: { id: 44, name: "Album", picUrl: "https://img.example/wy.jpg" },
                  privilege: { maxbr: 320000, maxBrLevel: "exhigh" },
                  l: { size: 3_000_000 },
                  h: { size: 7_000_000 },
                },
              },
            },
          ],
        },
      });
    case "jadeite.migu.cn":
      return Response.json({
        code: "000000",
        songResultData: {
          totalCount: "1",
          resultList: [
            [
              {
                songId: "505",
                copyrightId: "mg-copyright",
                name: "Migu Song",
                singerList: [{ name: "Singer" }],
                album: "Album",
                albumId: "55",
                duration: 184,
                img3: "https://img.example/mg.jpg",
                audioFormats: [
                  { formatType: "PQ", asize: 3_000_000 },
                  { formatType: "HQ", asize: 7_000_000 },
                ],
              },
            ],
          ],
        },
      });
    default:
      return new Response("not found", { status: 404 });
  }
};

const service = new MusicSearchService(
  new MusicOutboundHttp(fetcher, async () => [{ address: "8.8.8.8", family: 4 }]),
);

function expectedPictureUrl(source: MusicSourcePlatform): string {
  switch (source) {
    case "kw":
    case "kg":
      return "";
    case "tx":
      return "https://y.gtimg.cn/music/photo_new/T002R500x500M000tx-album-mid.jpg";
    case "wy":
      return "https://img.example/wy.jpg";
    case "mg":
      return "https://img.example/mg.jpg";
    case "local":
      return "";
  }
}

function expectedTitle(source: MusicSourcePlatform): string {
  switch (source) {
    case "kw":
      return "Kuwo Song";
    case "kg":
      return "Kugou Song";
    case "tx":
      return "Tencent Song";
    case "wy":
      return "Netease Song";
    case "mg":
      return "Migu Song";
    case "local":
      return "";
  }
}

describe("LX-compatible music search", () => {
  it("normalizes all supported platform results into playable MusicInfo", async () => {
    const sources: ReadonlyArray<MusicSourcePlatform> = ["kw", "kg", "tx", "wy", "mg"];
    for (const source of sources) {
      const result = await service.search(MusicSearchRequest.make({ source, query: "Song" }));
      expect(result.source).toBe(source);
      expect(result.total).toBe(1);
      expect(result.tracks).toHaveLength(1);
      expect(result.tracks[0]).toMatchObject({
        source,
        title: expectedTitle(source),
        artist: "Singer",
        album: "Album",
        durationSeconds: expect.any(Number),
        pictureUrl: source === "kw" || source === "kg" ? null : expectedPictureUrl(source),
        qualitys: ["128k", "320k"],
        musicInfo: {
          source,
          name: expectedTitle(source),
          songmid: expect.anything(),
          singer: "Singer",
          meta: {
            albumName: "Album",
            qualitys: [
              { type: "128k" },
              { type: "320k" },
            ],
          },
        },
      });
    }
  });

  it("preserves per-quality Kugou hashes needed by URL resolution", async () => {
    const result = await service.search(
      MusicSearchRequest.make({ source: "kg", query: "Kugou Song" }),
    );
    expect(result.tracks[0]?.musicInfo).toMatchObject({
      id: "202_kg-128",
      songmid: 202,
      hash: "kg-128",
      meta: {
        hash: "kg-128",
        _qualitys: {
          "128k": { hash: "kg-128" },
          "320k": { hash: "kg-320" },
        },
      },
    });
  });

  it("rejects local search", async () => {
    await expect(
      service.search(MusicSearchRequest.make({ source: "local", query: "Song" })),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
