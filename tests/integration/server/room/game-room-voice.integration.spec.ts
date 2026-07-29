import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SKIN_ID } from "$lib/game/internal-skins";
import {
  decodeServerMessage,
  GAME_PROTOCOL_VERSION,
  type VoiceParticipant,
  type VoiceSignalForwardMessage,
} from "$lib/protocol";
import { GameRoom, type GameRoomConnection } from "$lib/server/room/game-room";

function connection(
  id: string,
  playerId: string,
  nickname: string,
): {
  readonly connection: GameRoomConnection;
  readonly sent: Array<string | Uint8Array | ArrayBuffer>;
} {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  return {
    sent,
    connection: {
      id,
      identity: {
        playerId,
        nickname,
        skinId: DEFAULT_SKIN_ID,
        sessionExpiresAt: Date.now() + 60_000,
      },
      send(message): number {
        sent.push(message);
        return 1;
      },
      close(): void {},
    },
  };
}

function latestRoster(
  messages: ReadonlyArray<string | Uint8Array | ArrayBuffer>,
): ReadonlyArray<VoiceParticipant> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const wire = messages[index];
    if (typeof wire !== "string") continue;
    const message = Effect.runSync(decodeServerMessage(wire));
    if (message._tag === "voice-roster" || message._tag === "welcome") return message.voice;
  }
  throw new Error("voice roster was not sent");
}

function latestVoiceSignal(
  messages: ReadonlyArray<string | Uint8Array | ArrayBuffer>,
): VoiceSignalForwardMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const wire = messages[index];
    if (typeof wire !== "string") continue;
    const message = Effect.runSync(decodeServerMessage(wire));
    if (message._tag === "voice-signal") return message;
  }
  return undefined;
}

describe("game room voice membership", () => {
  it("sends input acknowledgement only after the authoritative tick executes", async () => {
    const room = new GameRoom();
    const alpha = connection("connection-a", "friend-a", "Alpha");

    try {
      room.connect(alpha.connection);
      room.receive(
        alpha.connection.id,
        JSON.stringify({
          v: GAME_PROTOCOL_VERSION,
          _tag: "input",
          sequence: 1,
          targetTick: 3,
          angle: Math.PI / 2,
          boosting: false,
        }),
      );
      expect(
        alpha.sent.some((wire) =>
          typeof wire === "string"
            ? Effect.runSync(decodeServerMessage(wire))._tag === "input-ack"
            : false,
        ),
      ).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 220));
      const acknowledgements = alpha.sent
        .filter((wire): wire is string => typeof wire === "string")
        .map((wire) => Effect.runSync(decodeServerMessage(wire)))
        .filter((message) => message._tag === "input-ack");
      expect(acknowledgements).toHaveLength(1);
      expect(acknowledgements[0]).toMatchObject({
        sequence: 1,
        targetTick: 3,
        appliedTick: 3,
      });
    } finally {
      room.dispose();
    }
  });

  it("tracks listening and microphone publication independently", () => {
    const room = new GameRoom();
    const alpha = connection("connection-a", "friend-a", "Alpha");
    const beta = connection("connection-b", "friend-b", "Beta");

    try {
      room.connect(alpha.connection);
      room.connect(beta.connection);
      expect(latestRoster(beta.sent)).toEqual([]);

      room.receive(
        alpha.connection.id,
        JSON.stringify({
          v: GAME_PROTOCOL_VERSION,
          _tag: "voice-state",
          listening: true,
          microphoneEnabled: false,
          muted: false,
        }),
      );
      expect(latestRoster(beta.sent)).toEqual([
        {
          playerId: "friend-a",
          nickname: "Alpha",
          microphoneEnabled: false,
          muted: true,
        },
      ]);

      room.receive(
        alpha.connection.id,
        JSON.stringify({
          v: GAME_PROTOCOL_VERSION,
          _tag: "voice-state",
          listening: true,
          microphoneEnabled: true,
          muted: false,
        }),
      );
      expect(latestRoster(beta.sent)).toEqual([
        {
          playerId: "friend-a",
          nickname: "Alpha",
          microphoneEnabled: true,
          muted: false,
        },
      ]);

      room.receive(
        alpha.connection.id,
        JSON.stringify({
          v: GAME_PROTOCOL_VERSION,
          _tag: "voice-state",
          listening: false,
          microphoneEnabled: false,
          muted: true,
        }),
      );
      expect(latestRoster(beta.sent)).toEqual([]);
    } finally {
      room.dispose();
    }
  });

  it("authorizes signaling for listeners without a microphone", () => {
    const room = new GameRoom();
    const alpha = connection("connection-a", "friend-a", "Alpha");
    const beta = connection("connection-b", "friend-b", "Beta");

    try {
      room.connect(alpha.connection);
      room.connect(beta.connection);
      for (const participant of [alpha, beta]) {
        room.receive(
          participant.connection.id,
          JSON.stringify({
            v: GAME_PROTOCOL_VERSION,
            _tag: "voice-state",
            listening: true,
            microphoneEnabled: false,
            muted: true,
          }),
        );
      }

      room.receive(
        alpha.connection.id,
        JSON.stringify({
          v: GAME_PROTOCOL_VERSION,
          _tag: "voice-signal",
          targetPlayerId: "friend-b",
          signal: { _tag: "offer", sdp: "v=0\r\n" },
        }),
      );

      expect(latestVoiceSignal(beta.sent)).toMatchObject({
        fromPlayerId: "friend-a",
        signal: { _tag: "offer", sdp: "v=0\r\n" },
      });
    } finally {
      room.dispose();
    }
  });
});
