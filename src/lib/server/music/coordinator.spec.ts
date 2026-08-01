import { describe, expect, it } from "vite-plus/test";
import {
  MusicPauseControl,
  MusicPlayControl,
  MusicResolvedTrack,
  MusicResumeControl,
  MusicSeekControl,
  MusicStopControl,
  type BilibiliAudioQuality,
  type MusicPlaybackState,
} from "../../protocol";
import { MusicCoordinator, type MusicResolver } from "./coordinator";

interface PendingResolution {
  readonly reference: string;
  readonly quality: BilibiliAudioQuality;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (result: MusicResolvedTrack) => void;
}

function harness() {
  const pending: Array<PendingResolution> = [];
  const states: Array<MusicPlaybackState> = [];
  const failures: Array<string> = [];
  let now = 1_000;
  const resolver: MusicResolver = {
    resolve(reference, quality, signal) {
      return new Promise((resolve) => pending.push({ reference, quality, signal, resolve }));
    },
  };
  const coordinator = new MusicCoordinator(
    resolver,
    {
      stateChanged: (state) => states.push(state),
      commandFailed: (playerId) => failures.push(playerId),
    },
    () => now,
  );
  return {
    coordinator,
    pending,
    states,
    failures,
    setNow(value: number) {
      now = value;
    },
  };
}

const alpha = { playerId: "alpha", nickname: "Alpha" };
const beta = { playerId: "beta", nickname: "Beta" };

function play(reference: string): MusicPlayControl {
  return MusicPlayControl.make({ reference, quality: "192k" });
}

function track(title: string): MusicResolvedTrack {
  return MusicResolvedTrack.make({
    bvid: "BV1xx411c7mD",
    title,
    artist: "Artist",
    pictureUrl: `https://img.example.test/${title}.jpg`,
    durationSeconds: 180,
    quality: "192k",
    url: `https://example.test/${title}.mp3`,
  });
}

describe("competitive music coordinator", () => {
  it("lets the last signed reference win even when an older resolution finishes later", async () => {
    const test = harness();
    test.coordinator.control(alpha, play("first-reference".repeat(3)));
    test.coordinator.control(beta, play("second-reference".repeat(3)));

    expect(test.pending[0]?.signal?.aborted).toBe(true);
    test.pending[0]?.resolve(track("First"));
    test.pending[1]?.resolve(track("Second"));
    await Promise.resolve();

    expect(test.coordinator.state._tag).toBe("playing");
    if (test.coordinator.state._tag !== "playing") throw new Error("Expected playing state");
    expect(test.coordinator.state.track.title).toBe("Second");
    expect(test.coordinator.state.changedBy.playerId).toBe("beta");
    expect(test.coordinator.state.revision).toBe(2);
  });

  it("anchors pause, seek, and resume to server time", async () => {
    const test = harness();
    test.coordinator.control(alpha, play("track-reference".repeat(3)));
    test.pending[0]?.resolve(track("Track"));
    await Promise.resolve();

    test.setNow(3_500);
    test.coordinator.control(beta, MusicPauseControl.make());
    expect(test.coordinator.state).toMatchObject({
      _tag: "paused",
      positionSeconds: 2.5,
      changedBy: beta,
    });

    test.coordinator.control(alpha, MusicSeekControl.make({ positionSeconds: 20 }));
    expect(test.coordinator.state).toMatchObject({ _tag: "paused", positionSeconds: 20 });

    test.setNow(4_000);
    test.coordinator.control(beta, MusicResumeControl.make());
    expect(test.coordinator.state).toMatchObject({
      _tag: "playing",
      positionSeconds: 20,
      anchorServerTime: 4_000,
    });

    test.coordinator.control(alpha, MusicStopControl.make());
    expect(test.coordinator.state).toMatchObject({ _tag: "stopped", changedBy: alpha });
  });
});
