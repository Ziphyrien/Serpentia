import { describe, expect, it } from "vite-plus/test";
import type { GameSnapshot, SnakeSnapshot } from "$lib/protocol";
import { SnapshotBuffer } from "./snapshot-buffer";

function snake(id: string, x: number, alive = true): SnakeSnapshot {
  return {
    id,
    nickname: id,
    body: [{ x, y: 0 }],
    angle: 0,
    targetAngle: 0,
    radius: 11,
    length: 100,
    score: 0,
    kills: 0,
    boosting: false,
    alive,
    invulnerable: false,
    respawnAtTick: null,
    lastInputSequence: -1,
  };
}

function snapshot(tick: number, x: number): GameSnapshot {
  return {
    tick,
    snakes: [snake("self", x), snake("remote", x)],
    foods: [],
    leaderboard: [],
  };
}

function remoteX(buffer: SnapshotBuffer, renderTime: number): number {
  const remote = buffer.sampleRemoteSnakes(renderTime)[0];
  if (!remote) throw new Error("remote snake was not sampled");
  return remote.body[0].x;
}

describe("snapshot buffer", () => {
  it("keeps interpolation continuous when a new frame arrives", () => {
    const buffer = new SnapshotBuffer(() => "self");
    buffer.push(snapshot(2, 100), 100);
    buffer.push(snapshot(4, 200), 200);

    expect(buffer.interpolationDelay()).toBe(140);
    expect(remoteX(buffer, 159)).toBeCloseTo(159, 8);

    buffer.push(snapshot(6, 300), 300);
    expect(remoteX(buffer, 160)).toBeCloseTo(160, 8);
  });

  it("resets stale interpolation history for a new connection", () => {
    const buffer = new SnapshotBuffer(() => "self");
    buffer.push(snapshot(2, 100), 100);
    buffer.push(snapshot(4, 200), 200);
    buffer.reset();
    buffer.push(snapshot(20, 900), 1_000);

    expect(buffer.latestSnapshot?.tick).toBe(20);
    expect(buffer.interpolationDelay()).toBe(90);
    expect(remoteX(buffer, 900)).toBe(900);
  });

  it("ignores out-of-order frames and excludes the locally predicted snake", () => {
    const buffer = new SnapshotBuffer(() => "self");
    buffer.push(snapshot(4, 200), 200);
    buffer.push(snapshot(2, 100), 100);

    const remotes = buffer.sampleRemoteSnakes(200);
    expect(buffer.latestSnapshot?.tick).toBe(4);
    expect(remotes).toHaveLength(1);
    expect(remotes[0].id).toBe("remote");
  });
});
