import { Container, Sprite, Texture } from "pixi.js";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SKIN_ID,
  bodyPointIndexes,
  internalSkinOrDefault,
  skinSizeInfo,
} from "$lib/game/internal-skins";
import {
  advanceSnakeSourceFrame,
  createBody,
  normalizeAngle,
  snakeMotionRules,
  targetSnakeBodyScale,
  type SnakeMotionState,
} from "$lib/game/snake-motion";
import type { SkinFrameTextures } from "./assets";
import { SnakeLayer } from "./snake-layer";

const motion = snakeMotionRules({ tickRate: 20, minimumLength: 80, maximumLength: 100_000 });

function angleDifference(left: number, right: number): number {
  return Math.abs(normalizeAngle(left - right));
}

describe("SnakeLayer trajectory orientation", () => {
  it("renders the head from current direction and body nodes from their historical path", () => {
    const skin = internalSkinOrDefault(DEFAULT_SKIN_ID);
    const texture = Texture.EMPTY;
    const frames: SkinFrameTextures = new Map(
      Object.keys(skin.frames).map((name) => [name, texture] as const),
    );
    const layer = new SnakeLayer(new Map([[skin.id, frames]]), texture, texture);
    const length = 200;
    const snake: SnakeMotionState = {
      body: createBody({ x: 0, y: 0 }, 0, length, motion),
      angle: 0,
      targetAngle: Math.PI / 2,
      length,
      bodyScale: targetSnakeBodyScale(length, motion.minimumLength),
      boosting: false,
      boostInputHeld: false,
      boostFrames: 0,
    };
    for (let frame = 0; frame < 6; frame += 1) advanceSnakeSourceFrame(snake, motion);

    layer.update(
      [
        {
          id: "self",
          nickname: "Self",
          skinId: skin.id,
          body: snake.body,
          angle: snake.angle,
          bodyScale: snake.bodyScale,
          boosting: false,
          invulnerable: false,
          magnetActive: true,
          isSelf: true,
        },
      ],
      { left: -10_000, top: -10_000, right: 10_000, bottom: 10_000 },
      false,
      0,
    );

    const snakeContainer = layer.container.children[0] as Container;
    const magnetContainer = layer.container.children[1] as Container;
    const root = snakeContainer.children[0] as Container;
    const bodyLayer = root.children[0] as Container;
    const head = root.children[1] as Sprite;
    const magnetEffect = magnetContainer.children[0];
    expect(magnetEffect.visible).toBe(true);
    expect(magnetEffect.position.x).toBeCloseTo(snake.body[0].x, 12);
    expect(magnetEffect.position.y).toBeCloseTo(snake.body[0].y, 12);
    expect(angleDifference(head.rotation, snake.angle + Math.PI / 2)).toBeLessThan(1e-12);
    expect(head.position.x).toBeCloseTo(snake.body[0].x, 12);
    expect(head.position.y).toBeCloseTo(snake.body[0].y, 12);

    const indexes = bodyPointIndexes(skinSizeInfo(skin, snake.bodyScale), snake.body.length);
    const firstBodyPointIndex = indexes[1];
    expect(firstBodyPointIndex).toBeDefined();
    const point = snake.body[firstBodyPointIndex];
    const behind = snake.body[firstBodyPointIndex + 1];
    const expectedBodyDirection = Math.atan2(point.y - behind.y, point.x - behind.x);
    const firstBodyNode = bodyLayer.children[bodyLayer.children.length - 1] as Sprite;
    expect(firstBodyNode.position.x).toBeCloseTo(point.x, 12);
    expect(firstBodyNode.position.y).toBeCloseTo(point.y, 12);
    expect(
      angleDifference(firstBodyNode.rotation, expectedBodyDirection + Math.PI / 2),
    ).toBeLessThan(1e-12);
    expect(angleDifference(firstBodyNode.rotation, head.rotation)).toBeGreaterThan(0.01);

    layer.destroy();
  });
});
