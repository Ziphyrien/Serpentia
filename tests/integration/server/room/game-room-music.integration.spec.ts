import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import { DEFAULT_SKIN_ID } from "$lib/game/internal-skins";
import {
  GAME_PROTOCOL_VERSION,
  MusicResolvedTrack,
  decodeServerMessage,
} from "$lib/protocol";
import type { MusicResolver } from "$lib/server/music/coordinator";
import { GameRoom, type GameRoomConnection } from "$lib/server/room/game-room";

interface PendingResolution {
  readonly signal: AbortSignal | undefined;
  readonly resolve: (result: MusicResolvedTrack) => void;
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

function resolvedTrack(title: string): MusicResolvedTrack {
  return MusicResolvedTrack.make({
    bvid: "BV1xx411c7mD",
    title,
    artist: "Fixture UP",
    pictureUrl: `https://img.example.test/${title}.jpg`,
    durationSeconds: 180,
    quality: "192k",
    url: `https://audio.example.test/${title}.mp3`,
  });
}

it("lets every player compete while the last signed Bilibili reference wins", async () => {
  const pending: Array<PendingResolution> = [];
  const resolver: MusicResolver = {
    resolve(_reference, _quality, signal) {
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
          reference: "first-reference".repeat(3),
          quality: "192k",
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
          reference: "second-reference".repeat(3),
          quality: "192k",
        },
      }),
    );

    expect(pending[0]?.signal?.aborted).toBe(true);
    pending[0]?.resolve(resolvedTrack("First"));
    pending[1]?.resolve(resolvedTrack("Second"));
    await Promise.resolve();

    expect(latestMusic(alpha.sent)).toMatchObject({
      _tag: "playing",
      revision: 2,
      changedBy: { playerId: "friend-b", nickname: "Beta" },
      track: {
        title: "Second",
        quality: "192k",
        pictureUrl: "https://img.example.test/Second.jpg",
        url: "https://audio.example.test/Second.mp3",
      },
    });
    expect(latestMusic(beta.sent)).toEqual(latestMusic(alpha.sent));
  } finally {
    room.dispose();
  }
});
