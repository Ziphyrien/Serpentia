import { Texture } from "pixi.js";
import { describe, expect, it } from "vite-plus/test";
import type { FoodConsumedEvent, FoodState } from "$lib/protocol";
import { FoodLayer } from "./food-layer";

const VIEW = { left: -1_000, top: -1_000, right: 1_000, bottom: 1_000 };
const FOOD: FoodState = {
  id: 7,
  position: { x: 0, y: 0 },
  value: 1,
  lengthValue: 1,
  variant: 0,
  generation: 0,
  kind: "ambient",
};
const EVENT: FoodConsumedEvent = {
  playerId: "self",
  sourceFrame: 120,
  food: FOOD,
  target: { x: 12, y: 6 },
};

function layer(): FoodLayer {
  return new FoodLayer(
    { starFoodValue: 10 },
    { dots: [Texture.EMPTY], star: Texture.EMPTY, candy: [Texture.EMPTY] },
  );
}

function predict(
  food: FoodLayer,
  visibleHead: { readonly x: number; readonly y: number },
  presentationSourceFrame: number,
  collisionHead = visibleHead,
  collisionSourceFrame = Math.ceil(presentationSourceFrame),
): Array<FoodState> {
  return food.predictSelfContacts(
    "self",
    visibleHead,
    collisionHead,
    18,
    1.6,
    presentationSourceFrame,
    collisionSourceFrame,
  );
}

function advance(
  food: FoodLayer,
  presentationSourceFrame: number,
  head: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
): Array<FoodConsumedEvent> {
  return food.update(
    VIEW,
    () => presentationSourceFrame,
    () => head,
  );
}

describe("food layer absorb timeline", () => {
  it("does not jump a late authoritative food away from its visible position", () => {
    const food = layer();
    const frontFood: FoodState = { ...FOOD, position: { x: 52, y: 6 } };
    const frontEvent: FoodConsumedEvent = { ...EVENT, food: frontFood };
    food.sync([frontFood], VIEW, 114);
    expect(food.startAbsorb(frontEvent)).toBe(true);

    expect(advance(food, 116)).toEqual([]);
    expect(food.positionOf(FOOD.id)).toMatchObject({ x: 52, y: 6 });

    expect(advance(food, 126)).toEqual([frontEvent]);
    // 权威事件激活时必须保持此前可见位置连续，不能先向蛇头前方跳出去。
    expect(food.positionOf(FOOD.id)).toMatchObject({ x: 52, y: 6 });

    // 远端权威 Food 使用碰撞时锁定的目标。
    expect(advance(food, 132)).toEqual([]);
    const midpoint = food.positionOf(FOOD.id);
    expect(midpoint?.x).toBeCloseTo(32);
    expect(midpoint?.y).toBeCloseTo(6);

    advance(food, 138);
    expect(food.positionOf(FOOD.id)).toBeUndefined();
    food.destroy();
  });

  it("starts on the first predicted head contact and moves inward on the next source frame", () => {
    const food = layer();
    const contactFood: FoodState = { ...FOOD, position: { x: 41, y: 0 } };
    food.sync([contactFood], VIEW, 114);

    expect(predict(food, { x: -1, y: 0 }, 119)).toEqual([]);
    expect(predict(food, { x: 0, y: 0 }, 120)).toEqual([contactFood]);
    expect(food.positionOf(FOOD.id)?.x).toBe(41);

    advance(food, 121, { x: 4.5, y: 0 });
    const firstStep = food.positionOf(FOOD.id);
    expect(firstStep?.x).toBeCloseTo(41 + (4.5 - 41) / 12);
    expect(firstStep?.x).toBeLessThan(41);
    food.destroy();
  });

  it("requires both the smooth visible head and discrete source-frame head to touch", () => {
    const food = layer();
    const contactFood: FoodState = { ...FOOD, position: { x: 41, y: 0 } };
    food.sync([contactFood], VIEW, 114);

    expect(predict(food, { x: 0, y: 0 }, 120, { x: -1, y: 0 }, 120)).toEqual([]);
    expect(predict(food, { x: 0, y: 0 }, 120, { x: 4.5, y: 0 }, 121)).toEqual([contactFood]);
    food.destroy();
  });

  it("does not predict a star from its stale visible position", () => {
    const food = layer();
    const visibleStar: FoodState = {
      ...FOOD,
      position: { x: 41, y: 0 },
      value: 10,
      lengthValue: 10,
      motion: { directionDegrees: 0, linearFramesRemaining: 20 },
    };
    const authoritativeStar: FoodState = {
      ...visibleStar,
      position: { x: 80, y: 0 },
    };
    food.sync([visibleStar], VIEW, 114, [authoritativeStar]);

    expect(predict(food, { x: 0, y: 0 }, 120)).toEqual([]);
    expect(food.positionOf(FOOD.id)).toMatchObject({ x: 41, y: 0 });
    food.destroy();
  });

  it("predicts a star when its known target-frame position also touches", () => {
    const food = layer();
    const visibleStar: FoodState = {
      ...FOOD,
      position: { x: 41, y: 0 },
      value: 10,
      lengthValue: 10,
      motion: { directionDegrees: 180, linearFramesRemaining: 20 },
    };
    const authoritativeStar: FoodState = {
      ...visibleStar,
      position: { x: 20, y: 0 },
    };
    food.sync([visibleStar], VIEW, 114, [authoritativeStar]);

    expect(predict(food, { x: 0, y: 0 }, 120)).toEqual([authoritativeStar]);
    food.destroy();
  });

  it("waits for authority when a star can randomly turn before the collision frame", () => {
    const food = layer();
    const star: FoodState = {
      ...FOOD,
      position: { x: 41, y: 0 },
      value: 10,
      lengthValue: 10,
      motion: { directionDegrees: 180, linearFramesRemaining: 6 },
    };
    food.sync([star], VIEW, 114);

    expect(predict(food, { x: 0, y: 0 }, 120)).toEqual([]);
    food.destroy();
  });

  it("tracks a boosted head instead of ending at its historical collision point", () => {
    const food = layer();
    const contactFood: FoodState = { ...FOOD, position: { x: 41, y: 0 } };
    food.sync([contactFood], VIEW, 114);

    expect(predict(food, { x: 0, y: 0 }, 120, { x: 9, y: 0 }, 121)).toEqual([contactFood]);
    for (let frame = 1; frame <= 12; frame += 1) {
      advance(food, 120 + frame, { x: frame * 9, y: 0 });
    }
    expect(food.positionOf(FOOD.id)?.x).toBeCloseTo(108);
    expect(food.positionOf(FOOD.id)?.y).toBe(0);
    food.destroy();
  });

  it("confirms a predicted contact without restarting its twelve-frame animation", () => {
    const food = layer();
    const contactFood: FoodState = { ...FOOD, position: { x: 41, y: 0 } };
    const confirmedEvent: FoodConsumedEvent = {
      ...EVENT,
      food: contactFood,
      target: { x: 0, y: 0 },
    };
    food.sync([contactFood], VIEW, 114);
    predict(food, { x: 0, y: 0 }, 120);

    advance(food, 126);
    expect(food.positionOf(FOOD.id)?.x).toBeCloseTo(20.5);
    expect(food.startAbsorb(confirmedEvent)).toBe(true);

    expect(advance(food, 127)).toEqual([]);
    expect(food.positionOf(FOOD.id)?.x).toBeCloseTo(41 - (41 / 12) * 7);

    advance(food, 132);
    expect(food.positionOf(FOOD.id)).toBeUndefined();
    food.destroy();
  });

  it("rolls a rejected prediction back to authority without retriggering while still touching", () => {
    const food = layer();
    const contactFood: FoodState = { ...FOOD, position: { x: 41, y: 0 } };
    food.sync([contactFood], VIEW, 114);
    predict(food, { x: 0, y: 0 }, 120);
    advance(food, 121, { x: 4.5, y: 0 });
    expect(food.positionOf(FOOD.id)?.x).toBeLessThan(41);

    // 服务端追到预测帧仍报告该食物，说明本次本机预测未被确认。
    food.sync([contactFood], VIEW, 120);
    expect(food.positionOf(FOOD.id)?.x).toBe(41);
    expect(predict(food, { x: 0, y: 0 }, 121)).toEqual([]);

    // 蛇头离开接触圈后才允许对同一份食物重新预测。
    expect(predict(food, { x: 100, y: 0 }, 122)).toEqual([]);
    expect(predict(food, { x: 0, y: 0 }, 123)).toEqual([contactFood]);
    food.destroy();
  });

  it("does not mistake a buffered pre-collision position for a same-id respawn", () => {
    const food = layer();
    food.sync([FOOD], VIEW, 114);
    food.startAbsorb(EVENT);
    advance(food, 120);

    const bufferedOldFood: FoodState = { ...FOOD, position: { x: 2, y: 0 } };
    food.sync([bufferedOldFood], VIEW, 123);
    advance(food, 132);
    expect(food.positionOf(FOOD.id)).toBeUndefined();

    food.sync([bufferedOldFood], VIEW, 135);
    expect(food.positionOf(FOOD.id)).toBeUndefined();
    food.destroy();
  });

  it("switches a cached same-id respawn on the twelfth presentation source frame", () => {
    const food = layer();
    const respawned: FoodState = {
      ...FOOD,
      generation: 1,
      position: { x: 200, y: -150 },
    };
    food.sync([FOOD], VIEW, 114);
    food.startAbsorb(EVENT);
    food.sync([respawned], VIEW, 132);

    advance(food, 120);
    advance(food, 131);
    expect(food.positionOf(FOOD.id)).toMatchObject({ x: 11, y: 5.5 });

    advance(food, 132);
    expect(food.positionOf(FOOD.id)).toMatchObject({ x: 200, y: -150 });
    food.destroy();
  });
});
