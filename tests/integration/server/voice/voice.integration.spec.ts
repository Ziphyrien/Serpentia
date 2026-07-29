import { describe, it } from "vite-plus/test";
import { Effect } from "effect";
import { decodeClientMessage, GAME_PROTOCOL_VERSION } from "$lib/protocol/game";
import { createCoturnCredentials } from "$lib/server/voice/coturn";
import { VoiceRoster } from "$lib/server/voice/voice-roster";
import { requireCondition } from "../../../support/assertions";
async function expectedCoturnCredential(secret: string, username: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(username)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
describe("friend room voice state", () => {
  it("voice roster separates listeners from microphone publishers", () => {
    const roster = new VoiceRoster();
    requireCondition(roster.snapshot().length === 0, "ordinary room members entered voice");
    requireCondition(roster.upsert("friend-b", "Beta", false, false), "listener was not added");
    requireCondition(
      !roster.upsert("friend-b", "Beta", false, true),
      "equivalent listener state was not idempotent",
    );
    roster.upsert("friend-a", "Alpha", true, false);
    const snapshot = roster.snapshot();
    requireCondition(
      snapshot[0].playerId === "friend-a" && snapshot[0].microphoneEnabled && !snapshot[0].muted,
      "microphone publisher state was inconsistent",
    );
    requireCondition(
      snapshot[1].playerId === "friend-b" && !snapshot[1].microphoneEnabled && snapshot[1].muted,
      "listen-only participant was exposed as publishing",
    );
    requireCondition(roster.leave("friend-a"), "leaving member remained in voice roster");
    requireCondition(!roster.has("friend-a"), "inactive member remained signal-authorized");
  });
  it("versioned listening, microphone state, and P2P signals cross the schema boundary", () => {
    const state = Effect.runSync(
      decodeClientMessage(
        JSON.stringify({
          v: GAME_PROTOCOL_VERSION,
          _tag: "voice-state",
          listening: true,
          microphoneEnabled: false,
          muted: true,
        }),
      ),
    );
    requireCondition(state._tag === "voice-state", "voice state was not decoded");
    requireCondition(
      state.listening === true && state.microphoneEnabled === false && state.muted,
      "listening and microphone state were not independent",
    );
    const offer = Effect.runSync(
      decodeClientMessage(
        JSON.stringify({
          v: GAME_PROTOCOL_VERSION,
          _tag: "voice-signal",
          targetPlayerId: "friend-b",
          signal: { _tag: "offer", sdp: "v=0\r\n" },
        }),
      ),
    );
    requireCondition(offer._tag === "voice-signal", "voice signal was not decoded");
    requireCondition(offer.signal._tag === "offer", "offer payload changed type");
    requireCondition(offer.targetPlayerId === "friend-b", "voice target changed");
    const ice = Effect.runSync(
      decodeClientMessage(
        JSON.stringify({
          v: GAME_PROTOCOL_VERSION,
          _tag: "voice-signal",
          targetPlayerId: "friend-b",
          signal: {
            _tag: "ice",
            candidate: null,
            sdpMid: null,
            sdpMLineIndex: null,
            usernameFragment: null,
          },
        }),
      ),
    );
    requireCondition(ice._tag === "voice-signal", "ICE signal was not decoded");
    requireCondition(ice.signal._tag === "ice", "ICE payload changed type");
  });
  it("legacy joined voice state is rejected", () => {
    let rejected = false;
    try {
      Effect.runSync(
        decodeClientMessage(
          JSON.stringify({
            v: GAME_PROTOCOL_VERSION,
            _tag: "voice-state",
            joined: true,
            muted: false,
          }),
        ),
      );
    } catch {
      rejected = true;
    }
    requireCondition(rejected, "legacy voice membership was accepted");
  });
  it("coturn REST credentials are short lived and authenticated", async () => {
    const sharedSecret = "s".repeat(32);
    const credentials = await createCoturnCredentials(
      {
        stunUrls: ["stun:voice.example.com:3478"],
        turnUrls: [
          "turn:voice.example.com:3478?transport=udp",
          "turns:voice.example.com:5349?transport=tcp",
        ],
        sharedSecret,
      },
      "friend-a",
      { now: 1000, ttlSeconds: 3600 },
    );
    requireCondition(credentials.expiresAt === 3601000, "TURN expiry was calculated incorrectly");
    const turn = credentials.iceServers.find((server) => server.username !== undefined);
    requireCondition(turn !== undefined, "authenticated TURN server was removed");
    requireCondition(
      turn.username === "3601:friend-a",
      "coturn REST username did not bind expiry and player",
    );
    requireCondition(
      turn.credential === (await expectedCoturnCredential(sharedSecret, turn.username)),
      "coturn REST HMAC credential was incorrect",
    );
  });
  it("malformed coturn configuration fails closed", async () => {
    let rejected = false;
    try {
      await createCoturnCredentials(
        { stunUrls: [], turnUrls: [], sharedSecret: "short" },
        "friend-a",
        { ttlSeconds: 3600 },
      );
    } catch {
      rejected = true;
    }
    requireCondition(rejected, "invalid coturn configuration was accepted");
  });
  it("unversioned voice signaling is rejected", () => {
    let rejected = false;
    try {
      Effect.runSync(
        decodeClientMessage(
          JSON.stringify({
            _tag: "voice-signal",
            targetPlayerId: "friend-b",
            signal: { _tag: "answer", sdp: "v=0\r\n" },
          }),
        ),
      );
    } catch {
      rejected = true;
    }
    requireCondition(rejected, "unversioned signaling was accepted");
  });
});
