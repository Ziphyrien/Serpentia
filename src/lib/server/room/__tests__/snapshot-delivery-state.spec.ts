import { describe, expect, it } from "vite-plus/test";
import { SnapshotDeliveryState } from "../snapshot-delivery-state";

describe("snapshot delivery backpressure", () => {
  it("blocks snapshots after backpressure until one drain resync", () => {
    const state = new SnapshotDeliveryState();

    expect(state.shouldSendSnapshot("slow")).toBe(true);
    state.recordSend("slow", -1);
    expect(state.shouldSendSnapshot("slow")).toBe(false);
    expect(state.drain("slow")).toBe(true);
    expect(state.drain("slow")).toBe(false);
    expect(state.shouldSendSnapshot("slow")).toBe(true);
  });

  it("does not block successful or dropped sends and forgets closed connections", () => {
    const state = new SnapshotDeliveryState();

    state.recordSend("healthy", 128);
    state.recordSend("dropped", 0);
    expect(state.shouldSendSnapshot("healthy")).toBe(true);
    expect(state.shouldSendSnapshot("dropped")).toBe(true);

    state.recordSend("closed", -1);
    state.forget("closed");
    expect(state.shouldSendSnapshot("closed")).toBe(true);
  });
});
