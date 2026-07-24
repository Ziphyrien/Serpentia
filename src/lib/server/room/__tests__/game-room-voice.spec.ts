import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { decodeServerMessage, GAME_PROTOCOL_VERSION, type VoiceParticipant } from "$lib/protocol";
import { GameRoom, type GameRoomConnection } from "../game-room";

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

describe("game room voice membership", () => {
  it("keeps ordinary players out of voice until they explicitly join", () => {
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
          joined: true,
          muted: false,
        }),
      );
      expect(latestRoster(beta.sent)).toEqual([
        { playerId: "friend-a", nickname: "Alpha", muted: false },
      ]);

      room.receive(
        alpha.connection.id,
        JSON.stringify({
          v: GAME_PROTOCOL_VERSION,
          _tag: "voice-state",
          joined: false,
          muted: true,
        }),
      );
      expect(latestRoster(beta.sent)).toEqual([]);
    } finally {
      room.dispose();
    }
  });
});
