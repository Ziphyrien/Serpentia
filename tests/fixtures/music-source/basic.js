/*!
 * @name Fixture Source
 * @description Music runtime fixture
 * @version 1
 * @author Serpentia
 * @homepage https://example.test/source
 */

const { EVENT_NAMES, on, request, send } = globalThis.lx;

on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action === "musicUrl") {
    return new Promise((resolve, reject) => {
      request(
        `https://music.example.test/url/${source}/${info.musicInfo.hash}/${info.type}`,
        {
          method: "GET",
          headers: { "x-fixture": "1" },
        },
        (error, _response, body) => {
          if (error) reject(error);
          else resolve(body.url);
        },
      );
    });
  }
  if (action === "pic") return Promise.resolve("https://cdn.example.test/cover.jpg");
  if (action === "lyric") {
    return Promise.resolve({ lyric: "[00:00.00]Fixture", tlyric: null });
  }
  return Promise.reject(new Error("unsupported action"));
});

send(EVENT_NAMES.inited, {
  status: true,
  sources: {
    kw: {
      name: "Kuwo",
      type: "music",
      actions: ["musicUrl", "pic"],
      qualitys: ["128k", "320k", "hires"],
    },
    local: {
      name: "Local",
      type: "music",
      actions: ["musicUrl", "pic", "lyric"],
      qualitys: [],
    },
  },
});

send(EVENT_NAMES.updateAlert, {
  log: "Fixture update",
  updateUrl: "https://example.test/update",
});
