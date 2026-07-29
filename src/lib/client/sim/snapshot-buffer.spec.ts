import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SKIN_ID } from "$lib/game/internal-skins";
import type { FoodState, GameSnapshot, MagnetToolState, SnakeSnapshot } from "$lib/protocol";
import { SnapshotBuffer } from "./snapshot-buffer";

function snake(id: string, x: number, alive = true, skinId = DEFAULT_SKIN_ID): SnakeSnapshot {
  return {
    id,
    nickname: id,
    skinId,
    body: [{ x, y: 0 }],
    angle: 0,
    targetAngle: 0,
    bodyScale: 1,
    length: 100,
    score: 0,
    kills: 0,
    boosting: false,
    alive,
    invulnerable: false,
    respawnAtTick: null,
    lastInputSequence: -1,
    lastInputAppliedTick: 0,
  };
}

function food(id: number, x: number, y = 0): FoodState {
  return {
    id,
    position: { x, y },
    value: 10,
    lengthValue: 10,
    variant: 0,
    generation: 0,
    kind: "ambient",
  };
}

function magnet(id: number, x: number): MagnetToolState {
  return {
    id,
    position: { x, y: 0 },
    expiresAtSourceFrame: 1_000,
    directionDegrees: 0,
    linearFramesRemaining: 80,
  };
}

function snapshot(
  tick: number,
  x: number,
  bodyScale = 1,
  remoteSkinId = DEFAULT_SKIN_ID,
  foods: ReadonlyArray<FoodState> = [],
  magnets: ReadonlyArray<MagnetToolState> = [],
): GameSnapshot {
  return {
    tick,
    snakes: [snake("self", x), { ...snake("remote", x, true, remoteSkinId), bodyScale }],
    foods,
    ...(magnets.length === 0 ? {} : { magnets }),
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

  it("maps the remote render clock to the same fractional tick as snake interpolation", () => {
    const buffer = new SnapshotBuffer(() => "self");
    buffer.push(snapshot(20, 100), 1_000);
    buffer.push(snapshot(22, 200), 1_100);

    expect(buffer.presentationTick(1_000)).toBe(20);
    expect(buffer.presentationTick(1_025)).toBeCloseTo(20.5, 12);
    expect(buffer.presentationTick(1_075)).toBeCloseTo(21.5, 12);
    expect(buffer.presentationTick(1_100)).toBe(22);
  });

  it("smoothly interpolates continuous star movement", () => {
    const buffer = new SnapshotBuffer(() => "self");
    buffer.push(snapshot(2, 100, 1, DEFAULT_SKIN_ID, [food(1, 0)]), 100);
    buffer.push(snapshot(4, 200, 1, DEFAULT_SKIN_ID, [food(1, 18)]), 200);

    expect(buffer.sampleFoods(125)[0]?.position.x).toBeCloseTo(4.5);
    expect(buffer.sampleFoods(150)[0]?.position.x).toBeCloseTo(9);
    expect(buffer.sampleFoods(175)[0]?.position.x).toBeCloseTo(13.5);
  });

  it("does not interpolate a same-id safe respawn across the map", () => {
    const buffer = new SnapshotBuffer(() => "self");
    buffer.push(snapshot(2, 100, 1, DEFAULT_SKIN_ID, [food(1, 0)]), 100);
    const nextGeneration: FoodState = { ...food(1, 200, -200), generation: 1 };
    buffer.push(snapshot(4, 200, 1, DEFAULT_SKIN_ID, [nextGeneration]), 200);

    expect(buffer.sampleFoods(199)[0]?.position).toEqual({ x: 0, y: 0 });
    expect(buffer.sampleFoods(200)[0]?.position).toEqual({ x: 200, y: -200 });
  });

  it("switches disappearing and newly appearing foods only at the upper snapshot", () => {
    const disappearing = new SnapshotBuffer(() => "self");
    disappearing.push(snapshot(2, 100, 1, DEFAULT_SKIN_ID, [food(1, 0)]), 100);
    disappearing.push(snapshot(4, 200), 200);
    expect(disappearing.sampleFoods(199)).toHaveLength(1);
    expect(disappearing.sampleFoods(200)).toEqual([]);

    const appearing = new SnapshotBuffer(() => "self");
    appearing.push(snapshot(2, 100), 100);
    appearing.push(snapshot(4, 200, 1, DEFAULT_SKIN_ID, [food(1, 10)]), 200);
    expect(appearing.sampleFoods(199)).toEqual([]);
    expect(appearing.sampleFoods(200)).toHaveLength(1);
  });

  it("interpolates authoritative magnet movement and delays pickup removal", () => {
    const buffer = new SnapshotBuffer(() => "self");
    buffer.push(snapshot(2, 100, 1, DEFAULT_SKIN_ID, [], [magnet(1, 0)]), 100);
    buffer.push(snapshot(4, 200, 1, DEFAULT_SKIN_ID, [], [magnet(1, 18)]), 200);

    expect(buffer.sampleMagnets(150)[0]?.position.x).toBeCloseTo(9);
    buffer.push(snapshot(6, 300), 300);
    expect(buffer.sampleMagnets(299)).toHaveLength(1);
    expect(buffer.sampleMagnets(300)).toEqual([]);
  });

  it("keeps discrete authoritative fields throughout an interpolation interval", () => {
    const buffer = new SnapshotBuffer(() => "self");
    const before = snapshot(2, 100, 1, 1);
    const after = snapshot(4, 200, 1.1, 403);
    buffer.push(before, 100);
    buffer.push(after, 200);

    expect(buffer.sampleRemoteSnakes(199)[0]?.bodyScale).toBe(1);
    expect(buffer.sampleRemoteSnakes(199)[0]?.skinId).toBe(1);
    expect(buffer.sampleRemoteSnakes(200)[0]?.bodyScale).toBe(1.1);
    expect(buffer.sampleRemoteSnakes(200)[0]?.skinId).toBe(403);
  });
});
