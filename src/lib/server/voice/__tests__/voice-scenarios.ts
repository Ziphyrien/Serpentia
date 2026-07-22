import { Effect } from "effect";
import { decodeClientMessage } from "../../../protocol/game";
import { requestCloudflareTurnCredentials } from "../cloudflare-turn";
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
    name: "voice roster follows authenticated room membership and mute state",
    run: () => {
      const roster = new VoiceRoster();
      roster.join("friend-b", "Beta");
      roster.join("friend-a", "Alpha");
      requireCondition(
        roster.snapshot().every((participant) => participant.muted),
        "microphone was not private by default",
      );
      requireCondition(roster.setMuted("friend-a", false), "member could not unmute");
      requireCondition(!roster.setMuted("intruder", false), "unknown player changed voice state");
      const snapshot = roster.snapshot();
      requireCondition(
        snapshot[0].playerId === "friend-a" && !snapshot[0].muted,
        "voice roster was inconsistent",
      );
      requireCondition(roster.leave("friend-a"), "leaving member remained in voice roster");
    },
  },
  {
    name: "versioned P2P offer answer and ICE messages cross the schema boundary",
    run: () => {
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
    name: "Cloudflare TURN credentials are short lived, authenticated, and browser safe",
    run: async () => {
      const turnKeyId = "a".repeat(32);
      const turnKeyApiToken = "b".repeat(64);
      const fakeFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        requireCondition(
          request.headers.get("authorization") === `Bearer ${turnKeyApiToken}`,
          "TURN key was not sent as a bearer secret",
        );
        const payload: unknown = await request.json();
        requireCondition(
          typeof payload === "object" &&
            payload !== null &&
            "customIdentifier" in payload &&
            payload.customIdentifier === "friend-a",
          "TURN request was not attributed to the authenticated player",
        );
        return Response.json(
          {
            iceServers: [
              {
                urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"],
              },
              {
                urls: [
                  "turn:turn.cloudflare.com:3478?transport=udp",
                  "turn:turn.cloudflare.com:53?transport=udp",
                  "turns:turn.cloudflare.com:443?transport=tcp",
                ],
                username: "temporary-user",
                credential: "temporary-credential",
              },
            ],
          },
          { status: 201 },
        );
      };

      const credentials = await Effect.runPromise(
        requestCloudflareTurnCredentials({ turnKeyId, turnKeyApiToken }, "friend-a", {
          fetcher: fakeFetch,
          now: 1_000,
          ttlSeconds: 3_600,
        }),
      );
      requireCondition(
        credentials.expiresAt === 3_601_000,
        "TURN expiry was calculated incorrectly",
      );
      requireCondition(
        credentials.iceServers.some((iceServer) => iceServer.username === "temporary-user"),
        "authenticated TURN server was removed",
      );
      requireCondition(
        credentials.iceServers.every((iceServer) =>
          iceServer.urls.every((url) => !url.includes(":53")),
        ),
        "browser-blocked port 53 candidate was returned",
      );
    },
  },
  {
    name: "malformed Cloudflare TURN responses fail closed",
    run: async () => {
      let rejected = false;
      try {
        await Effect.runPromise(
          requestCloudflareTurnCredentials(
            { turnKeyId: "a".repeat(32), turnKeyApiToken: "b".repeat(64) },
            "friend-a",
            {
              fetcher: async () => Response.json({ iceServers: [] }, { status: 201 }),
              ttlSeconds: 3_600,
            },
          ),
        );
      } catch {
        rejected = true;
      }
      requireCondition(rejected, "TURN response without relay credentials was accepted");
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
