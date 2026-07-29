import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SKIN_ID } from "$lib/game/internal-skins";
import { decodeServerMessage } from "$lib/protocol";
import { GameRoom, type GameRoomConnection } from "$lib/server/room/game-room";

function connection(id: string, playerId: string, nickname: string) {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  const closed: Array<{ readonly code: number; readonly reason: string }> = [];
  const value: GameRoomConnection = {
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
    close(code, reason): void {
      closed.push({ code, reason });
    },
  };
  return { value, sent, closed };
}

describe("game room connection rejection", () => {
  it("rejects a duplicate nickname with a localized close reason", () => {
    const room = new GameRoom();
    const first = connection("connection-a", "friend-a", "Alpha");
    const duplicate = connection("connection-b", "friend-b", "ＡLPHA");

    try {
      room.connect(first.value);
      room.connect(duplicate.value);

      const messages = duplicate.sent.map((wire) => Effect.runSync(decodeServerMessage(wire)));
      expect(messages).toContainEqual({
        v: expect.any(Number),
        _tag: "error",
        code: "NICKNAME_IN_USE",
        retryable: false,
      });
      expect(duplicate.closed).toEqual([{ code: 4409, reason: "昵称已被占用，请更换昵称" }]);
    } finally {
      room.dispose();
    }
  });
});
