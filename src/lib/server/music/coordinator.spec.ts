import { describe, expect, it } from "vite-plus/test";
import {
  MusicPauseControl,
  MusicPlayControl,
  MusicResumeControl,
  MusicSeekControl,
  MusicStopControl,
  MusicUrlResolveResult,
  type MusicPlaybackState,
  type MusicSourceResolveRequest,
  type MusicSourceResolveResponse,
} from "../../protocol";
import { MusicCoordinator, type MusicResolver } from "./coordinator";

interface PendingResolution {
  readonly request: MusicSourceResolveRequest;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (result: MusicSourceResolveResponse) => void;
}

function harness() {
  const pending: Array<PendingResolution> = [];
  const states: Array<MusicPlaybackState> = [];
  const failures: Array<string> = [];
  let now = 1_000;
  const resolver: MusicResolver = {
    resolve(request, signal) {
      return new Promise((resolve) => pending.push({ request, signal, resolve }));
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

function play(title: string): MusicPlayControl {
  return MusicPlayControl.make({
    source: "kw",
    info: { type: "320k", musicInfo: { hash: title } },
    title,
    artist: "Artist",
  });
}

describe("competitive music coordinator", () => {
  it("lets the last play command win even when an older resolution finishes later", async () => {
    const test = harness();
    test.coordinator.control(alpha, play("First"));
    test.coordinator.control(beta, play("Second"));

    expect(test.pending[0]?.signal?.aborted).toBe(true);
    test.pending[0]?.resolve(
      MusicUrlResolveResult.make({
        source: "kw",
        action: "musicUrl",
        data: { type: "320k", url: "https://example.test/first.mp3" },
      }),
    );
    test.pending[1]?.resolve(
      MusicUrlResolveResult.make({
        source: "kw",
        action: "musicUrl",
        data: { type: "320k", url: "https://example.test/second.mp3" },
      }),
    );
    await Promise.resolve();

    expect(test.coordinator.state._tag).toBe("playing");
    if (test.coordinator.state._tag !== "playing") throw new Error("Expected playing state");
    expect(test.coordinator.state.track.title).toBe("Second");
    expect(test.coordinator.state.changedBy.playerId).toBe("beta");
    expect(test.coordinator.state.revision).toBe(2);
  });

  it("anchors pause, seek, and resume to server time", async () => {
    const test = harness();
    test.coordinator.control(alpha, play("Track"));
    test.pending[0]?.resolve(
      MusicUrlResolveResult.make({
        source: "kw",
        action: "musicUrl",
        data: { type: "320k", url: "https://example.test/track.mp3" },
      }),
    );
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
