import { Texture } from "pixi.js";
import { describe, expect, it } from "vite-plus/test";
import type { MagnetConsumedEvent, MagnetToolState } from "$lib/protocol";
import { MagnetToolLayer } from "./magnet-tool-layer";

const VIEW = { left: -1_000, top: -1_000, right: 1_000, bottom: 1_000 };
const AUTHORITY_SOURCE_FRAME = 114;
const PRESENTATION_SOURCE_FRAME = 120;
const MAGNET: MagnetToolState = {
  id: 1,
  position: { x: 0, y: 0 },
  expiresAtSourceFrame: 1_200,
  directionDegrees: 0,
  linearFramesRemaining: 100,
};
const PRESENTED_MAGNET: MagnetToolState = { ...MAGNET, position: { x: 18, y: 0 } };
const EVENT: MagnetConsumedEvent = {
  playerId: "self",
  sourceFrame: PRESENTATION_SOURCE_FRAME,
  magnet: PRESENTED_MAGNET,
  target: { x: 80, y: 0 },
};

function layer(): MagnetToolLayer {
  return new MagnetToolLayer(Texture.EMPTY, 2_448);
}

function sync(
  magnetLayer: MagnetToolLayer,
  presented: MagnetToolState = PRESENTED_MAGNET,
  authoritativeSourceFrame = AUTHORITY_SOURCE_FRAME,
  authoritative: ReadonlyArray<MagnetToolState> = [MAGNET],
): void {
  magnetLayer.sync([presented], VIEW, authoritativeSourceFrame, authoritative);
}

function predict(
  magnetLayer: MagnetToolLayer,
  visibleHead: { readonly x: number; readonly y: number },
  collisionHead = visibleHead,
  presentationSourceFrame = PRESENTATION_SOURCE_FRAME,
  collisionSourceFrame = Math.ceil(presentationSourceFrame),
): Array<MagnetToolState> {
  return magnetLayer.predictSelfContacts(
    "self",
    visibleHead,
    collisionHead,
    18,
    1.6,
    presentationSourceFrame,
    collisionSourceFrame,
  );
}

function update(
  magnetLayer: MagnetToolLayer,
  sourceFrame: number,
  head: { readonly x: number; readonly y: number } = EVENT.target,
): Array<MagnetConsumedEvent> {
  return magnetLayer.update(
    VIEW,
    () => sourceFrame,
    () => head,
  );
}

describe("magnet tool presentation", () => {
  it("tracks the current local head and confirms without restarting the animation", () => {
    const magnetLayer = layer();
    sync(magnetLayer);
    expect(predict(magnetLayer, { x: 80, y: 0 })).toEqual([MAGNET]);
    expect(magnetLayer.hasPredictedPickup("self")).toBe(true);

    const node = magnetLayer.container.children[0];
    expect(update(magnetLayer, 120)).toEqual([]);
    expect(node.position.x).toBe(18);

    for (let sourceFrame = 121; sourceFrame <= 126; sourceFrame += 1) {
      update(magnetLayer, sourceFrame, { x: 80 + (sourceFrame - 120) * 4.5, y: 0 });
    }
    const beforeAuthority = node.position.x;
    expect(magnetLayer.consume(EVENT)).toBe(true);

    for (let sourceFrame = 127; sourceFrame <= 131; sourceFrame += 1) {
      update(magnetLayer, sourceFrame, { x: 80 + (sourceFrame - 120) * 4.5, y: 0 });
    }
    expect(node.position.x).toBeGreaterThan(EVENT.target.x);
    expect(node.position.x).toBeGreaterThan(beforeAuthority);
    update(magnetLayer, 132, { x: 134, y: 0 });
    expect(magnetLayer.container.children).toHaveLength(0);
    magnetLayer.destroy();
  });

  it("requires both the visible and collision heads to touch", () => {
    const magnetLayer = layer();
    sync(magnetLayer);

    expect(predict(magnetLayer, { x: 80, y: 0 }, { x: 200, y: 0 })).toEqual([]);
    expect(predict(magnetLayer, { x: 80, y: 0 }, { x: 80, y: 0 })).toEqual([MAGNET]);
    magnetLayer.destroy();
  });

  it("does not predict through an unknown random turn or expiry", () => {
    const magnetLayer = layer();
    const uncertain: MagnetToolState = {
      ...MAGNET,
      expiresAtSourceFrame: PRESENTATION_SOURCE_FRAME,
      linearFramesRemaining: 6,
    };
    sync(magnetLayer, { ...uncertain, position: { x: 15, y: 0 } }, AUTHORITY_SOURCE_FRAME, [
      uncertain,
    ]);

    expect(predict(magnetLayer, { x: 80, y: 0 })).toEqual([]);
    magnetLayer.destroy();
  });

  it("rolls a rejected prediction back and blocks retriggering until the head leaves", () => {
    const magnetLayer = layer();
    sync(magnetLayer);
    expect(predict(magnetLayer, { x: 80, y: 0 })).toEqual([MAGNET]);

    const authoritativeAtCollision: MagnetToolState = {
      ...MAGNET,
      position: { x: 18, y: 0 },
      linearFramesRemaining: 94,
    };
    sync(magnetLayer, authoritativeAtCollision, 120, [authoritativeAtCollision]);
    expect(magnetLayer.hasPredictedPickup("self")).toBe(false);
    expect(predict(magnetLayer, { x: 80, y: 0 }, { x: 80, y: 0 }, 120, 120)).toEqual([]);

    expect(predict(magnetLayer, { x: 200, y: 0 }, { x: 200, y: 0 }, 121, 121)).toEqual([]);
    expect(predict(magnetLayer, { x: 80, y: 0 }, { x: 80, y: 0 }, 122, 122)).toEqual([
      authoritativeAtCollision,
    ]);
    magnetLayer.destroy();
  });

  it("hands a wrong local prediction to the authoritative remote consumer", () => {
    const magnetLayer = layer();
    sync(magnetLayer);
    predict(magnetLayer, { x: 80, y: 0 });
    update(magnetLayer, 126);
    const node = magnetLayer.container.children[0];
    const beforeAuthority = node.position.x;
    const remoteEvent: MagnetConsumedEvent = {
      ...EVENT,
      playerId: "remote",
      target: { x: 300, y: 0 },
    };

    expect(magnetLayer.consume(remoteEvent)).toBe(true);
    expect(magnetLayer.hasPredictedPickup("self")).toBe(false);
    expect(update(magnetLayer, 126)).toEqual([remoteEvent]);
    expect(node.position.x).toBeCloseTo(beforeAuthority, 10);
    magnetLayer.destroy();
  });

  it("falls back to the authority event when prediction is unavailable", () => {
    const magnetLayer = layer();
    expect(magnetLayer.consume(EVENT)).toBe(true);
    expect(update(magnetLayer, 120)).toEqual([EVENT]);
    const node = magnetLayer.container.children[0];

    update(magnetLayer, 126);
    expect(node.position.x).toBeCloseTo(49, 10);
    magnetLayer.destroy();
  });

  it("deduplicates repeated authority while an animation is active", () => {
    const magnetLayer = layer();
    expect(magnetLayer.consume(EVENT)).toBe(true);
    expect(magnetLayer.consume(EVENT)).toBe(false);
    magnetLayer.destroy();
  });
});
