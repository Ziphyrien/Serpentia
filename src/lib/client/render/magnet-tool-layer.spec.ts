import { Texture } from "pixi.js";
import { describe, expect, it } from "vite-plus/test";
import type { MagnetConsumedEvent, MagnetToolState } from "$lib/protocol";
import { MagnetToolLayer } from "./magnet-tool-layer";

const VIEW = { left: -1_000, top: -1_000, right: 1_000, bottom: 1_000 };
const MAGNET: MagnetToolState = {
  id: 1,
  position: { x: 0, y: 0 },
  expiresAtSourceFrame: 1_200,
  directionDegrees: 0,
  linearFramesRemaining: 100,
};
const EVENT: MagnetConsumedEvent = {
  playerId: "self",
  sourceFrame: 120,
  magnet: MAGNET,
  target: { x: 120, y: 60 },
};

describe("magnet tool presentation", () => {
  it("flies the official tool sprite to the locked snake head in 0.2 seconds", () => {
    const layer = new MagnetToolLayer(Texture.EMPTY);
    layer.sync([MAGNET], VIEW);
    expect(layer.consume(EVENT)).toBe(true);

    expect(layer.update(VIEW, () => 120)).toEqual([EVENT]);
    const node = layer.container.children[0];
    expect(node.position.x).toBe(0);
    expect(node.position.y).toBe(0);

    expect(layer.update(VIEW, () => 126)).toEqual([]);
    expect(node.position.x).toBeCloseTo(60, 10);
    expect(node.position.y).toBeCloseTo(30, 10);

    expect(layer.update(VIEW, () => 132)).toEqual([]);
    expect(layer.container.children).toHaveLength(0);
    layer.destroy();
  });

  it("deduplicates repeated authority for one pickup", () => {
    const layer = new MagnetToolLayer(Texture.EMPTY);
    expect(layer.consume(EVENT)).toBe(true);
    expect(layer.consume(EVENT)).toBe(false);
    layer.destroy();
  });
});
