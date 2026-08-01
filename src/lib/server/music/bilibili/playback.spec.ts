import { describe, expect, it } from "vite-plus/test";
import { selectAudio } from "./playback";

describe("Bilibili playback selection", () => {
  it("selects the exact requested regular DASH quality", () => {
    const data = {
      dash: {
        audio: [
          { id: 30232, baseUrl: "https://a.bilivideo.com/132.m4s", backupUrl: [] },
          { id: 30280, baseUrl: "https://a.bilivideo.com/192.m4s", backupUrl: [] },
        ],
      },
    };
    expect(selectAudio(data, "132k")).toMatchObject({
      quality: "132k",
      urls: [expect.stringContaining("132.m4s")],
    });
    expect(selectAudio(data, "192k")).toMatchObject({
      quality: "192k",
      urls: [expect.stringContaining("192.m4s")],
    });
  });

  it("falls back to the highest available regular quality", () => {
    const data = {
      dash: {
        audio: [
          { id: 30216, baseUrl: "https://a.bilivideo.com/64.m4s", backupUrl: [] },
          { id: 30232, baseUrl: "https://a.bilivideo.com/132.m4s", backupUrl: [] },
        ],
      },
    };
    expect(selectAudio(data, "192k")).toMatchObject({
      quality: "132k",
      urls: [expect.stringContaining("132.m4s")],
    });
  });

  it("never upgrades above the requested ceiling", () => {
    const data = {
      dash: {
        audio: [{ id: 30280, baseUrl: "https://a.bilivideo.com/192.m4s", backupUrl: [] }],
      },
    };
    expect(() => selectAudio(data, "132k")).toThrow();
  });

  it("supports old videos that only expose durl", () => {
    const data = {
      durl: [
        {
          url: "https://a.bilivideo.com/legacy.mp4",
          backup_url: ["https://b.bilivideo.com/legacy.mp4"],
        },
      ],
    };
    expect(selectAudio(data, "192k")).toMatchObject({
      quality: "64k",
      urls: [
        "https://a.bilivideo.com/legacy.mp4",
        "https://b.bilivideo.com/legacy.mp4",
      ],
    });
  });
});
