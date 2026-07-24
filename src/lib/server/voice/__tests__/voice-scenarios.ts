import { Effect } from "effect";
import { decodeClientMessage } from "../../../protocol/game";
import { createCoturnCredentials } from "../coturn";
import { VoiceRoster } from "../voice-roster";

export interface VoiceScenario {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export const voiceScenarios: ReadonlyArray<VoiceScenario> = [
  {
    name: "voice roster contains active members and their mute state only",
    run: () => {
      const roster = new VoiceRoster();
      requireCondition(roster.snapshot().length === 0, "ordinary room members entered voice");
      roster.join("friend-b", "Beta", true);
      roster.join("friend-a", "Alpha", false);
      const snapshot = roster.snapshot();
      requireCondition(
        snapshot[0].playerId === "friend-a" && !snapshot[0].muted,
        "voice roster was inconsistent",
      );
      requireCondition(roster.leave("friend-a"), "leaving member remained in voice roster");
      requireCondition(!roster.has("friend-a"), "inactive member remained signal-authorized");
    },
  },
  {
    name: "versioned voice membership and P2P signals cross the schema boundary",
    run: () => {
      const state = Effect.runSync(
        decodeClientMessage(
          JSON.stringify({ v: 1, _tag: "voice-state", joined: false, muted: true }),
        ),
      );
      requireCondition(state._tag === "voice-state", "voice state was not decoded");
      requireCondition(state.joined === false && state.muted, "voice membership changed");

      const offer = Effect.runSync(
        decodeClientMessage(
          JSON.stringify({
            v: 1,
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
            v: 1,
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
    },
  },
  {
    name: "coturn REST credentials are short lived and authenticated",
    run: async () => {
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
        { now: 1_000, ttlSeconds: 3_600 },
      );
      requireCondition(
        credentials.expiresAt === 3_601_000,
        "TURN expiry was calculated incorrectly",
      );
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
    },
  },
  {
    name: "malformed coturn configuration fails closed",
    run: async () => {
      let rejected = false;
      try {
        await createCoturnCredentials(
          { stunUrls: [], turnUrls: [], sharedSecret: "short" },
          "friend-a",
          { ttlSeconds: 3_600 },
        );
      } catch {
        rejected = true;
      }
      requireCondition(rejected, "invalid coturn configuration was accepted");
    },
  },
  {
    name: "unversioned voice signaling is rejected",
    run: () => {
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
    },
  },
];

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
