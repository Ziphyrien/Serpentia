import { describe, expect, it } from "vite-plus/test";
import {
  INTERNAL_SKINS,
  bodyNodeAt,
  fixedSkinFrameScale,
  internalSkin,
  nodeFrameName,
  skinFrame,
  skinSizeInfo,
  type InternalSkin,
  type SkinNode,
} from "./internal-skins";

const OFFICIAL_IDS = [1, 2, 3, 4, 10, 11, 101, 111, 112, 132, 133, 139, 401, 403, 411, 701];

function requiredSkin(id: number): InternalSkin {
  const skin = internalSkin(id);
  if (skin === undefined) throw new Error(`Missing test skin ${id}`);
  return skin;
}

function nodesOf(skin: InternalSkin): ReadonlyArray<SkinNode> {
  return [
    skin.head,
    ...(skin.headSpeed === null ? [] : [skin.headSpeed]),
    ...skin.body,
    ...skin.bodySpeed,
    ...(skin.tail === null ? [] : [skin.tail]),
    ...(skin.tailSpeed === null ? [] : [skin.tailSpeed]),
  ];
}

describe("official internal skins", () => {
  it("contains exactly the sixteen NormalRepeat endless skins", () => {
    expect(INTERNAL_SKINS.map((skin) => skin.id)).toEqual(OFFICIAL_IDS);
    expect(INTERNAL_SKINS.every((skin) => skin.bodyRenderWidthRate === 1)).toBe(true);
  });

  it("resolves every normal and speed frame with a positive normalized frame time", () => {
    for (const skin of INTERNAL_SKINS) {
      for (const node of nodesOf(skin)) {
        expect(node.frameTime, `skin ${skin.id} frame time`).toBeGreaterThan(0);
        for (const name of node.textures) {
          expect(skinFrame(skin, name), `skin ${skin.id} frame ${name}`).toBeDefined();
        }
      }
    }
  });

  it("keeps every swapped texture inside the fixed normal-frame quad", () => {
    for (const skin of INTERNAL_SKINS) {
      const size = skinSizeInfo(skin, 1);
      const groups: ReadonlyArray<{
        readonly nodes: ReadonlyArray<SkinNode>;
        readonly width: number;
        readonly height: number;
      }> = [
        {
          nodes: [skin.head, ...(skin.headSpeed === null ? [] : [skin.headSpeed])],
          width: size.headWidth,
          height: size.headHeight,
        },
        {
          nodes: [...skin.body, ...skin.bodySpeed],
          width: size.bodyWidth,
          height: size.bodyHeight,
        },
        {
          nodes: [
            ...(skin.tail === null ? [] : [skin.tail]),
            ...(skin.tailSpeed === null ? [] : [skin.tailSpeed]),
          ],
          width: size.tailWidth,
          height: size.tailHeight,
        },
      ];

      for (const group of groups) {
        for (const node of group.nodes) {
          for (const name of node.textures) {
            const frame = skinFrame(skin, name);
            const scale = fixedSkinFrameScale(group.width, group.height, frame.width, frame.height);
            expect(frame.width * scale.x, `skin ${skin.id} ${name} width`).toBeCloseTo(group.width);
            expect(frame.height * scale.y, `skin ${skin.id} ${name} height`).toBeCloseTo(
              group.height,
            );
          }
        }
      }
    }
  });

  it("stretches skin 133's 48x50 alternate body into the original 48x48 quad", () => {
    const skin = requiredSkin(133);
    const size = skinSizeInfo(skin, 1);
    const alternate = skinFrame(skin, "snakebody1");
    const scale = fixedSkinFrameScale(
      size.bodyWidth,
      size.bodyHeight,
      alternate.width,
      alternate.height,
    );

    expect(alternate.width).toBe(48);
    expect(alternate.height).toBe(50);
    expect(scale.x).toBeCloseTo(0.75);
    expect(scale.y).toBeCloseTo(0.72);
    expect(alternate.width * scale.x).toBeCloseTo(36);
    expect(alternate.height * scale.y).toBeCloseTo(36);
  });

  it("preserves skin 101's four offset six-frame body-speed cycles", () => {
    const skin = requiredSkin(101);
    expect(skin.bodySpeed).toHaveLength(4);
    expect(skin.bodySpeed.every((node) => node.frameTime === 6)).toBe(true);
    expect(nodeFrameName(bodyNodeAt(skin.bodySpeed, 1), 1)).toBe("20170315043643");
    expect(nodeFrameName(bodyNodeAt(skin.bodySpeed, 1), 6)).toBe("20170315043646");
    expect(nodeFrameName(bodyNodeAt(skin.bodySpeed, 2), 1)).toBe("20170315043646");
  });

  it("keeps skin 403's rotated head and tail plus its speed tail", () => {
    const skin = requiredSkin(403);
    expect(skinFrame(skin, skin.head.textures[0]).rotated).toBe(true);
    expect(skin.tail).not.toBeNull();
    expect(skin.tailSpeed).not.toBeNull();
    if (skin.tail === null || skin.tailSpeed === null) throw new Error("Skin 403 tail missing");
    expect(skinFrame(skin, skin.tail.textures[0]).rotated).toBe(true);
    expect(skin.tailSpeed.textures).toEqual(skin.tail.textures);
  });

  it("uses the official multi-frame speed heads for skins 411 and 701", () => {
    const skin411 = requiredSkin(411);
    const skin701 = requiredSkin(701);
    if (skin411.headSpeed === null || skin701.headSpeed === null) {
      throw new Error("Animated speed head missing");
    }

    expect(skin411.headSpeed.textures).toHaveLength(12);
    expect(skin411.headSpeed.frameTime).toBe(3);
    expect(nodeFrameName(skin411.headSpeed, 1)).toBe("snakehead1");
    expect(nodeFrameName(skin411.headSpeed, 3)).toBe("snakehead2");

    expect(skin701.head.textures).toHaveLength(2);
    expect(skin701.headSpeed.textures).toHaveLength(7);
    expect(skin701.headSpeed.frameTime).toBe(6);
    expect(nodeFrameName(skin701.headSpeed, 1)).toBe("snakehead2");
    expect(nodeFrameName(skin701.headSpeed, 6)).toBe("snakehead3");
  });

  it("keeps skin 701's multi-frame head valid when the animation clock is slightly negative", () => {
    const skin = requiredSkin(701);
    expect(nodeFrameName(skin.head, -1)).toBe("snakehead0");
    expect(nodeFrameName(skin.head, Number.NaN)).toBe("snakehead0");
  });

  it("falls back to normal skin frames for skins 3 and 4 while retaining universal flow", () => {
    for (const id of [3, 4]) {
      const skin = requiredSkin(id);
      expect(skin.headSpeed).toBeNull();
      expect(skin.bodySpeed).toEqual([]);
      expect(skin.tailSpeed).toBeNull();
    }
  });
});
