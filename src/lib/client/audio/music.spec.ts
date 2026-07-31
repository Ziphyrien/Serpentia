import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MusicControllerInfo,
  MusicPausedState,
  MusicPlayingState,
  MusicResolvedTrack,
} from "$lib/protocol";

interface SoundInstance {
  currentSeek: number;
  playingValue: boolean;
  volumeValue: number;
  playCount: number;
  pauseCount: number;
  stopCount: number;
  unloaded: boolean;
  onload: () => void;
  onplay: () => void;
}

const audio = vi.hoisted((): { instances: Array<SoundInstance> } => ({ instances: [] }));

vi.mock("howler", () => ({
  Howl: class {
    currentSeek = 0;
    playingValue = false;
    volumeValue: number;
    playCount = 0;
    pauseCount = 0;
    stopCount = 0;
    unloaded = false;
    onload: () => void;
    onplay: () => void;

    constructor(options: {
      readonly volume: number;
      readonly onload: () => void;
      readonly onplay: () => void;
    }) {
      this.volumeValue = options.volume;
      this.onload = options.onload;
      this.onplay = options.onplay;
      audio.instances.push(this);
    }

    state(): string {
      return "loaded";
    }

    duration(): number {
      return 180;
    }

    seek(position?: number): number | this {
      if (position === undefined) return this.currentSeek;
      this.currentSeek = position;
      return this;
    }

    playing(): boolean {
      return this.playingValue;
    }

    play(): number {
      this.playingValue = true;
      this.playCount += 1;
      return this.playCount;
    }

    pause(): this {
      this.playingValue = false;
      this.pauseCount += 1;
      return this;
    }

    stop(): this {
      this.playingValue = false;
      this.stopCount += 1;
      return this;
    }

    volume(value: number): this {
      this.volumeValue = value;
      return this;
    }

    unload(): void {
      this.unloaded = true;
    }
  },
  Howler: { ctx: undefined },
}));

import { MusicPlayback, expectedPosition } from "./music";

const actor = MusicControllerInfo.make({ playerId: "alpha", nickname: "Alpha" });
const track = MusicResolvedTrack.make({
  source: "kw",
  title: "Track",
  artist: "Artist",
  type: "320k",
  url: "https://audio.example.test/track.mp3",
});

beforeEach(() => {
  audio.instances.length = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
});

describe("synchronized music playback", () => {
  it("seeks to the server-anchored position and corrects drift", () => {
    let serverNow = 3_000;
    const playback = new MusicPlayback(() => serverNow);
    const state = MusicPlayingState.make({
      revision: 1,
      changedAt: 1_000,
      changedBy: actor,
      track,
      positionSeconds: 0,
      anchorServerTime: 1_000,
    });

    playback.apply(state);
    const sound = audio.instances[0];
    expect(sound?.currentSeek).toBe(2);
    expect(sound?.playCount).toBe(1);

    if (sound === undefined) throw new Error("Expected music sound");
    sound.currentSeek = 2.1;
    serverNow = 3_220;
    sound.onload();
    expect(sound.currentSeek).toBe(2.1);

    // The actual media element may start later than play() resolves; onplay immediately
    // catches a one-syllable-sized startup lag instead of waiting for the 1s timer.
    serverNow = 3_300;
    sound.onplay();
    expect(sound.currentSeek).toBe(2.3);

    sound.currentSeek = 0;
    sound.onload();
    expect(sound.currentSeek).toBe(2.3);
    playback.dispose();
  });

  it("applies pause and local music volume independently", () => {
    const playback = new MusicPlayback(() => 5_000);
    playback.setVolume(0.4);
    playback.apply(
      MusicPlayingState.make({
        revision: 1,
        changedAt: 1_000,
        changedBy: actor,
        track,
        positionSeconds: 0,
        anchorServerTime: 1_000,
      }),
    );
    playback.apply(
      MusicPausedState.make({
        revision: 2,
        changedAt: 5_000,
        changedBy: actor,
        track,
        positionSeconds: 12,
      }),
    );

    const sound = audio.instances[0];
    expect(sound?.volumeValue).toBe(0.4);
    expect(sound?.pauseCount).toBe(1);
    expect(sound?.currentSeek).toBe(12);
    playback.dispose();
    expect(sound?.unloaded).toBe(true);
  });

  it("computes a shared progress from server time", () => {
    const state = MusicPlayingState.make({
      revision: 1,
      changedAt: 10_000,
      changedBy: actor,
      track,
      positionSeconds: 8,
      anchorServerTime: 10_000,
    });

    expect(expectedPosition(state, 12_500)).toBe(10.5);
  });
});
