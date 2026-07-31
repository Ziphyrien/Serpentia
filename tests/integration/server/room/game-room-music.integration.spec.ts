import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import { DEFAULT_SKIN_ID } from "$lib/game/internal-skins";
import {
  GAME_PROTOCOL_VERSION,
  MusicUrlResolveResult,
  decodeServerMessage,
  type MusicSourceResolveRequest,
  type MusicSourceResolveResponse,
} from "$lib/protocol";
import type { MusicResolver } from "$lib/server/music/coordinator";
import { GameRoom, type GameRoomConnection } from "$lib/server/room/game-room";

interface PendingResolution {
  readonly signal: AbortSignal | undefined;
  readonly resolve: (result: MusicSourceResolveResponse) => void;
}

function connection(id: string, playerId: string, nickname: string) {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
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
    close: () => {},
  };
  return { value, sent };
}

function latestMusic(sent: ReadonlyArray<string | Uint8Array | ArrayBuffer>) {
  return sent
    .filter((wire): wire is string => typeof wire === "string")
    .map((wire) => Effect.runSync(decodeServerMessage(wire)))
    .filter((message) => message._tag === "music-state")
    .at(-1)?.music;
}

it("lets every player compete while the last server-received play command wins", async () => {
  const pending: Array<PendingResolution> = [];
  const resolver: MusicResolver = {
    resolve(_request: MusicSourceResolveRequest, signal?: AbortSignal) {
      return new Promise((resolve) => pending.push({ signal, resolve }));
    },
  };
  const room = new GameRoom(undefined, resolver);
  const alpha = connection("connection-a", "friend-a", "Alpha");
  const beta = connection("connection-b", "friend-b", "Beta");

  try {
    room.connect(alpha.value);
    room.connect(beta.value);
    room.receive(
      alpha.value.id,
      JSON.stringify({
        v: GAME_PROTOCOL_VERSION,
        _tag: "music-control",
        command: {
          _tag: "play",
          source: "kw",
          info: { type: "320k", musicInfo: { hash: "first" } },
          title: "First",
          artist: "Alpha",
        },
      }),
    );
    room.receive(
      beta.value.id,
      JSON.stringify({
        v: GAME_PROTOCOL_VERSION,
        _tag: "music-control",
        command: {
          _tag: "play",
          source: "kw",
          info: { type: "320k", musicInfo: { hash: "second" } },
          title: "Second",
          artist: "Beta",
        },
      }),
    );

    expect(pending[0]?.signal?.aborted).toBe(true);
    pending[0]?.resolve(
      MusicUrlResolveResult.make({
        source: "kw",
        action: "musicUrl",
        data: { type: "320k", url: "https://audio.example.test/first.mp3" },
      }),
    );
    pending[1]?.resolve(
      MusicUrlResolveResult.make({
        source: "kw",
        action: "musicUrl",
        data: { type: "320k", url: "https://audio.example.test/second.mp3" },
      }),
    );
    await Promise.resolve();

    expect(latestMusic(alpha.sent)).toMatchObject({
      _tag: "playing",
      revision: 2,
      changedBy: { playerId: "friend-b", nickname: "Beta" },
      track: { title: "Second", url: "https://audio.example.test/second.mp3" },
    });
    expect(latestMusic(beta.sent)).toEqual(latestMusic(alpha.sent));
  } finally {
    room.dispose();
  }
});
