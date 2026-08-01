import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MusicControllerInfo,
  MusicPausedState,
  MusicPlayingState,
  MusicResolvedTrack,
} from "$lib/protocol";
import { MusicPlayback, expectedPosition } from "./music";

class MockAudioElement {
  src = "";
  preload = "";
  volume = 1;
  currentTime = 0;
  duration = 180;
  paused = true;
  readyState = 0;
  playCount = 0;
  pauseCount = 0;
  loadCount = 0;
  sourceRemoved = false;
  nextPlayFailure: Error | undefined;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor() {
    audio.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }

  play(): Promise<void> {
    this.playCount += 1;
    const failure = this.nextPlayFailure;
    this.nextPlayFailure = undefined;
    if (failure !== undefined) {
      this.paused = true;
      return Promise.reject(failure);
    }
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCount += 1;
    this.paused = true;
  }

  load(): void {
    this.loadCount += 1;
  }

  removeAttribute(name: string): void {
    if (name !== "src") return;
    this.src = "";
    this.sourceRemoved = true;
  }
}

const audio: { instances: Array<MockAudioElement> } = { instances: [] };
const windowListeners = new Map<string, EventListener>();

const actor = MusicControllerInfo.make({ playerId: "alpha", nickname: "Alpha" });
const track = MusicResolvedTrack.make({
  bvid: "BV1xx411c7mD",
  title: "Track",
  artist: "Artist",
  pictureUrl: null,
  durationSeconds: 180,
  quality: "192k",
  url: "/api/music/stream/signed-stream-payload.signed-stream-signature",
});

function playingState(
  revision: number,
  positionSeconds: number,
  anchorServerTime: number,
): MusicPlayingState {
  return MusicPlayingState.make({
    revision,
    changedAt: anchorServerTime,
    changedBy: actor,
    track,
    positionSeconds,
    anchorServerTime,
  });
}

beforeEach(() => {
  audio.instances.length = 0;
  windowListeners.clear();
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: MockAudioElement,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        windowListeners.delete(type);
      }),
    },
  });
});

describe("synchronized music playback", () => {
  it("starts on loadedmetadata without waiting for canplaythrough", async () => {
    const playback = new MusicPlayback(() => 3_000);
    playback.apply(playingState(1, 0, 1_000));

    const element = audio.instances[0];
    if (element === undefined) throw new Error("Expected audio element");
    expect(element.src).toBe(track.url);
    expect(element.preload).toBe("auto");
    expect(element.playCount).toBe(0);

    element.readyState = 1;
    element.dispatch("loadedmetadata");
    await Promise.resolve();
    expect(element.currentTime).toBe(2);
    expect(element.playCount).toBe(1);
    expect(element.paused).toBe(false);
    playback.dispose();
  });

  it("keeps play intent while applying an authoritative seek", async () => {
    let serverNow = 1_000;
    const playback = new MusicPlayback(() => serverNow);
    playback.apply(playingState(1, 0, 1_000));
    const element = audio.instances[0];
    if (element === undefined) throw new Error("Expected audio element");
    element.readyState = 4;
    element.dispatch("loadedmetadata");
    await Promise.resolve();

    serverNow = 5_000;
    playback.apply(playingState(2, 60, 5_000));
    expect(element.currentTime).toBe(60);
    expect(element.paused).toBe(false);
    expect(element.pauseCount).toBe(0);
    expect(audio.instances).toHaveLength(1);
    playback.dispose();
  });

  it("does not hard-seek or pause when streaming buffers run dry", async () => {
    let serverNow = 1_000;
    const playback = new MusicPlayback(() => serverNow);
    playback.apply(playingState(1, 0, 1_000));
    const element = audio.instances[0];
    if (element === undefined) throw new Error("Expected audio element");
    element.readyState = 4;
    element.dispatch("loadedmetadata");
    await Promise.resolve();

    element.currentTime = 10;
    serverNow = 20_000;
    element.dispatch("waiting");
    expect(element.currentTime).toBe(10);
    expect(element.paused).toBe(false);
    expect(element.pauseCount).toBe(0);
    playback.dispose();
  });

  it("restarts a paused media element as soon as canplay fires", async () => {
    const playback = new MusicPlayback(() => 1_000);
    playback.apply(playingState(1, 0, 1_000));
    const element = audio.instances[0];
    if (element === undefined) throw new Error("Expected audio element");
    element.readyState = 3;
    element.dispatch("loadedmetadata");
    await Promise.resolve();
    element.paused = true;

    element.dispatch("canplay");
    await Promise.resolve();
    expect(element.playCount).toBe(2);
    expect(element.paused).toBe(false);
    playback.dispose();
  });

  it("applies pause, resume, and local volume without rebuilding the source", async () => {
    const playback = new MusicPlayback(() => 5_000);
    playback.setVolume(0.4);
    playback.apply(playingState(1, 0, 1_000));
    const element = audio.instances[0];
    if (element === undefined) throw new Error("Expected audio element");
    element.readyState = 4;
    element.dispatch("loadedmetadata");
    await Promise.resolve();

    playback.apply(
      MusicPausedState.make({
        revision: 2,
        changedAt: 5_000,
        changedBy: actor,
        track,
        positionSeconds: 12,
      }),
    );
    expect(element.volume).toBe(0.4);
    expect(element.pauseCount).toBe(1);
    expect(element.currentTime).toBe(12);

    playback.apply(playingState(3, 12, 5_000));
    await Promise.resolve();
    expect(element.playCount).toBe(2);
    expect(element.paused).toBe(false);
    expect(audio.instances).toHaveLength(1);

    playback.dispose();
    expect(element.sourceRemoved).toBe(true);
  });

  it("retries playback from a later user gesture", async () => {
    const playback = new MusicPlayback(() => 1_000);
    playback.apply(playingState(1, 0, 1_000));
    const element = audio.instances[0];
    if (element === undefined) throw new Error("Expected audio element");
    element.readyState = 4;
    element.dispatch("loadedmetadata");
    await Promise.resolve();
    element.paused = true;

    windowListeners.get("pointerdown")?.(new Event("pointerdown"));
    await Promise.resolve();
    expect(element.playCount).toBe(2);
    expect(element.paused).toBe(false);
    playback.dispose();
  });

  it("reports media and non-abort playback failures", async () => {
    const failures: Array<string> = [];
    const playback = new MusicPlayback(() => 1_000, (failure) => failures.push(failure));
    playback.apply(playingState(1, 0, 1_000));
    const element = audio.instances[0];
    if (element === undefined) throw new Error("Expected audio element");
    element.dispatch("error");
    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    element.nextPlayFailure = denied;
    element.readyState = 4;
    element.dispatch("loadedmetadata");
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual(["load", "play"]);
    playback.dispose();
  });

  it("ignores stale playback revisions", async () => {
    const playback = new MusicPlayback(() => 1_000);
    playback.apply(playingState(2, 30, 1_000));
    const element = audio.instances[0];
    if (element === undefined) throw new Error("Expected audio element");
    element.readyState = 4;
    element.dispatch("loadedmetadata");
    await Promise.resolve();
    expect(element.currentTime).toBe(30);

    playback.apply(playingState(1, 5, 1_000));
    expect(element.currentTime).toBe(30);
    playback.dispose();
  });

  it("computes a shared progress from server time", () => {
    const state = playingState(1, 8, 10_000);
    expect(expectedPosition(state, 12_500)).toBe(10.5);
  });
});
