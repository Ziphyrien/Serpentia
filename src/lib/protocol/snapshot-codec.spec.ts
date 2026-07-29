import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SKIN_ID } from "$lib/game/internal-skins";
import { GAME_PROTOCOL_VERSION, type SnapshotMessage } from "./game";
import { SnapshotStreamDecoder, SnapshotStreamEncoder } from "./snapshot-codec";
import type { FoodState, SnakeSnapshot } from "./state";

function food(id: number): FoodState {
  return {
    id,
    position: { x: id, y: 0 },
    value: 2,
    lengthValue: 2,
    variant: id % 7,
    generation: 0,
    kind: "ambient",
  };
}

function snake(
  lastInputSequence: number,
  lastInputAppliedTick: number,
  bodyScale = 1.201,
  skinId = DEFAULT_SKIN_ID,
): SnakeSnapshot {
  return {
    id: "self",
    nickname: "Self",
    skinId,
    body: [
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ],
    angle: 0.5,
    targetAngle: 0.75,
    bodyScale,
    length: 100,
    score: 2,
    kills: 1,
    boosting: false,
    alive: true,
    invulnerable: false,
    respawnAtTick: null,
    lastInputSequence,
    lastInputAppliedTick,
  };
}

function snapshotMessage(
  tick: number,
  foods: ReadonlyArray<FoodState>,
  snakes: ReadonlyArray<SnakeSnapshot> = [],
): SnapshotMessage {
  return {
    v: GAME_PROTOCOL_VERSION,
    _tag: "snapshot",
    serverTime: 1_000 + tick * 50,
    snapshot: { tick, snakes, foods, leaderboard: [] },
    events: [],
  };
}

function decodeFoodIds(frames: ReadonlyArray<ReadonlyArray<number>>): Array<Array<number>> {
  const encoder = new SnapshotStreamEncoder();
  const decoder = new SnapshotStreamDecoder();
  return frames.map((ids, index) => {
    const message = snapshotMessage(
      index === 0 ? 1 : index * 2 + 1,
      ids.map((id) => food(id)),
    );
    const decoded = decoder.decode(encoder.encode(message));
    return decoded.snapshot.foods.map((item) => item.id);
  });
}

describe("snapshot snake input timeline", () => {
  it("round-trips the applied tick through keyframes and deltas", () => {
    const encoder = new SnapshotStreamEncoder();
    const decoder = new SnapshotStreamDecoder();
    const first = snapshotMessage(1, [], [snake(4, 10, 1.201, 1)]);
    const second = snapshotMessage(3, [], [snake(5, 12, 1.302, 403)]);

    const decodedFirst = decoder.decode(encoder.encode(first));
    const decodedSecond = decoder.decode(encoder.encode(second));
    expect(decodedFirst.snapshot.snakes[0].lastInputSequence).toBe(4);
    expect(decodedFirst.snapshot.snakes[0].lastInputAppliedTick).toBe(10);
    expect(decodedFirst.snapshot.snakes[0].bodyScale).toBe(1.201);
    expect(decodedFirst.snapshot.snakes[0].skinId).toBe(1);
    expect(decodedSecond.snapshot.snakes[0].lastInputSequence).toBe(5);
    expect(decodedSecond.snapshot.snakes[0].lastInputAppliedTick).toBe(12);
    expect(decodedSecond.snapshot.snakes[0].bodyScale).toBe(1.302);
    expect(decodedSecond.snapshot.snakes[0].skinId).toBe(403);
  });
});

describe("snapshot food motion", () => {
  it("round-trips star motion and the respawn generation through keyframes and deltas", () => {
    const encoder = new SnapshotStreamEncoder();
    const decoder = new SnapshotStreamDecoder();
    const first: FoodState = {
      ...food(1),
      motion: { directionDegrees: 359, linearFramesRemaining: 87 },
    };
    const second: FoodState = {
      ...first,
      position: { x: 4, y: -3 },
      generation: 1,
      motion: { directionDegrees: 90, linearFramesRemaining: 143 },
    };

    expect(decoder.decode(encoder.encode(snapshotMessage(1, [first]))).snapshot.foods).toEqual([
      first,
    ]);
    expect(decoder.decode(encoder.encode(snapshotMessage(3, [second]))).snapshot.foods).toEqual([
      second,
    ]);
  });
});

describe("snapshot consumed food events", () => {
  it("round-trips the consumer, source frame, food state, and locked collision target", () => {
    const encoder = new SnapshotStreamEncoder();
    const decoder = new SnapshotStreamDecoder();
    const consumed: FoodState = {
      id: 17,
      position: { x: 12.25, y: -4.5 },
      value: 3.5,
      lengthValue: 3,
      variant: 11,
      generation: 0,
      kind: "remains",
    };
    const message: SnapshotMessage = {
      ...snapshotMessage(7, [], [snake(-1, 0)]),
      events: [
        {
          tick: 7,
          deaths: [],
          consumedFoods: [
            {
              playerId: "self",
              sourceFrame: 19,
              food: consumed,
              target: { x: 20.5, y: -8.25 },
            },
          ],
          respawnedPlayerIds: [],
        },
      ],
    };

    const decoded = decoder.decode(encoder.encode(message));
    expect(decoded.events).toEqual(message.events);
  });
});

describe("snapshot food delta", () => {
  const removalCases: ReadonlyArray<{
    readonly name: string;
    readonly before: ReadonlyArray<number>;
    readonly after: ReadonlyArray<number>;
  }> = [
    { name: "removes the last food", before: [1, 2, 3], after: [1, 2] },
    { name: "removes multiple foods from the end", before: [1, 2, 3, 4], after: [1] },
    { name: "clears the food list", before: [1, 2], after: [] },
    { name: "removes a food from the middle", before: [1, 2, 3], after: [1, 3] },
  ];

  for (const testCase of removalCases) {
    it(`${testCase.name} without leaving a stale suffix`, () => {
      const decoded = decodeFoodIds([testCase.before, testCase.after, testCase.after]);
      expect(decoded[1]).toEqual(testCase.after);
      expect(decoded[2]).toEqual(testCase.after);
    });
  }
});
