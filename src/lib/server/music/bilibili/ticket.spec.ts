import { describe, expect, it } from "vite-plus/test";
import { BilibiliTrack } from "./contracts";
import { BilibiliTicketService } from "./ticket";

const track = BilibiliTrack.make({
  bvid: "BV1xx411c7mD",
  title: "Fixture",
  artist: "Fixture UP",
  pictureUrl: "https://i0.hdslb.com/fixture.jpg",
  durationSeconds: 120,
  cid: null,
});

describe("BilibiliTicketService", () => {
  it("round-trips signed track and stream tickets without exposing a CDN URL", async () => {
    const tickets = new BilibiliTicketService(
      "ticket-test-secret-at-least-32-characters",
      () => 1_700_000_000_000,
    );
    const trackToken = tickets.issueTrack(track);
    expect(await tickets.verifyTrack(trackToken)).toEqual(track);
    expect(trackToken).not.toContain("bilibili.com");

    const streamToken = tickets.issueStream(track.bvid, 123, "192k");
    expect(await tickets.verifyStream(streamToken)).toMatchObject({
      bvid: track.bvid,
      cid: 123,
      quality: "192k",
    });
  });

  it("rejects tampering and expiry", async () => {
    let now = 1_700_000_000_000;
    const tickets = new BilibiliTicketService(
      "ticket-test-secret-at-least-32-characters",
      () => now,
    );
    const token = tickets.issueTrack(track);
    await expect(tickets.verifyTrack(`${token.slice(0, -1)}x`)).rejects.toMatchObject({
      reason: "INVALID_REQUEST",
    });
    now += 25 * 60 * 60 * 1_000;
    await expect(tickets.verifyTrack(token)).rejects.toMatchObject({ reason: "INVALID_REQUEST" });
  });
});
