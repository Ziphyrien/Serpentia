import { describe, expect, it } from "vite-plus/test";
import type { SnakeSnapshot } from "$lib/protocol/state";
import {
  netStatusColor,
  projectGameMapPoint,
  rankAliveSnakes,
  selectGameMapMarkers,
  visibleHudRanks,
} from "./game-hud";

function snake(
  id: string,
  score: number,
  position: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
  alive = true,
): SnakeSnapshot {
  return {
    id,
    nickname: id,
    body: [position],
    angle: 0,
    skinId: 1,
    bodyScale: 1,
    length: 80,
    score,
    kills: 0,
    boosting: false,
    alive,
    invulnerable: false,
    respawnAtTick: null,
    lastInputSequence: -1,
    lastInputAppliedTick: 0,
  };
}

describe("original endless HUD ranking", () => {
  it("ranks living snakes by authoritative score with stable ties", () => {
    const ranked = rankAliveSnakes([
      snake("first-tie", 20),
      snake("dead", 100, undefined, false),
      snake("leader", 30),
      snake("second-tie", 20),
    ]);

    expect(ranked.map(({ playerId, rank, score }) => ({ playerId, rank, score }))).toEqual([
      { playerId: "leader", rank: 1, score: 30 },
      { playerId: "first-tie", rank: 2, score: 20 },
      { playerId: "second-tie", rank: 3, score: 20 },
    ]);
  });

  it("replaces row ten with the local player's true rank", () => {
    const ranked = rankAliveSnakes(
      Array.from({ length: 12 }, (_, index) => snake(`p${index + 1}`, 120 - index)),
    );

    const visible = visibleHudRanks(ranked, "p12");
    expect(visible).toHaveLength(10);
    expect(visible.slice(0, 9).map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(visible[9]).toMatchObject({ playerId: "p12", rank: 12 });
  });
});

describe("original endless minimap", () => {
  it("shows the leader and local player", () => {
    const snakes = [snake("leader", 30, { x: 100, y: 200 }), snake("me", 20, { x: -10, y: 5 })];
    const markers = selectGameMapMarkers(rankAliveSnakes(snakes), snakes, "me");

    expect(markers).toEqual([
      { playerId: "leader", kind: "top", rank: 1, position: { x: 100, y: 200 } },
      { playerId: "me", kind: "me", position: { x: -10, y: 5 } },
    ]);
  });

  it("crowns second place when the local player leads", () => {
    const snakes = [snake("me", 30), snake("target", 20)];
    const markers = selectGameMapMarkers(rankAliveSnakes(snakes), snakes, "me");

    expect(markers.map(({ playerId, kind, rank }) => ({ playerId, kind, rank }))).toEqual([
      { playerId: "target", kind: "top", rank: 2 },
      { playerId: "me", kind: "me", rank: undefined },
    ]);
  });

  it("crowns the top three and marks the rest with rank numbers", () => {
    const snakes = [
      snake("leader", 50, { x: 400, y: 0 }),
      snake("third", 30, { x: -100, y: 100 }),
      snake("me", 40, { x: 0, y: -200 }),
      snake("fourth", 20, { x: 50, y: 50 }),
      snake("dead", 999, { x: 1, y: 1 }, false),
    ];
    const markers = selectGameMapMarkers(rankAliveSnakes(snakes), snakes, "me");

    expect(markers.map(({ playerId, kind, rank }) => ({ playerId, kind, rank }))).toEqual([
      { playerId: "leader", kind: "top", rank: 1 },
      { playerId: "third", kind: "top", rank: 3 },
      { playerId: "fourth", kind: "player", rank: 4 },
      { playerId: "me", kind: "me", rank: undefined },
    ]);
  });

  it("crowns second place even when the local player trails", () => {
    const snakes = [
      snake("leader", 50, { x: 400, y: 0 }),
      snake("second", 40, { x: -100, y: 100 }),
      snake("me", 30, { x: 0, y: -200 }),
    ];
    const markers = selectGameMapMarkers(rankAliveSnakes(snakes), snakes, "me");

    expect(markers.map(({ playerId, kind, rank }) => ({ playerId, kind, rank }))).toEqual([
      { playerId: "leader", kind: "top", rank: 1 },
      { playerId: "second", kind: "top", rank: 2 },
      { playerId: "me", kind: "me", rank: undefined },
    ]);
  });

  it("maps the border-stripped world rectangle and clamps only requested markers", () => {
    expect(projectGameMapPoint({ x: 0, y: 0 }, 2448, false)).toEqual({ left: 80, top: 80 });
    expect(projectGameMapPoint({ x: -2432, y: 2432 }, 2448, false)).toEqual({
      left: 0,
      top: 160,
    });
    expect(projectGameMapPoint({ x: 0, y: -100 }, 2448, false)?.top).toBeLessThan(80);
    expect(projectGameMapPoint({ x: 0, y: 100 }, 2448, false)?.top).toBeGreaterThan(80);
    expect(projectGameMapPoint({ x: 2500, y: -2500 }, 2448, false)).toBeUndefined();
    expect(projectGameMapPoint({ x: 2500, y: -2500 }, 2448, true)).toEqual({
      left: 160,
      top: 0,
    });
  });
});

describe("original network status colors", () => {
  it("uses the 70ms and 90ms inclusive thresholds", () => {
    expect(netStatusColor(70)).toBe("rgb(5 199 13)");
    expect(netStatusColor(71)).toBe("rgb(255 172 0)");
    expect(netStatusColor(90)).toBe("rgb(255 172 0)");
    expect(netStatusColor(91)).toBe("rgb(255 87 88)");
  });
});
