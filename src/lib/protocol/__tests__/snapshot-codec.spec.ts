import { describe, expect, it } from "vite-plus/test";
import { GAME_PROTOCOL_VERSION, type SnapshotMessage } from "../game";
import { SnapshotStreamDecoder, SnapshotStreamEncoder } from "../snapshot-codec";
import type { FoodState } from "../state";

function food(id: number): FoodState {
  return { id, position: { x: id, y: 0 }, value: 2, kind: "ambient" };
}

function snapshotMessage(tick: number, foods: ReadonlyArray<FoodState>): SnapshotMessage {
  return {
    v: GAME_PROTOCOL_VERSION,
    _tag: "snapshot",
    serverTime: 1_000 + tick * 50,
    snapshot: { tick, snakes: [], foods, leaderboard: [] },
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
