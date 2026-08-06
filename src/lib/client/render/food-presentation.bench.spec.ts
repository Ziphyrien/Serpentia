import { Texture } from "pixi.js";
import { describe, expect, it } from "vite-plus/test";
import type { FoodConsumedEvent, FoodState } from "$lib/protocol";
import { foodRadiusOf } from "$lib/game/food-metrics";
import { predictFoodPresentationPosition } from "$lib/game/star-food-motion";
import { FoodLayer } from "./food-layer";
import { MovingFoodPresentation } from "./moving-food-presentation";

const FOOD_COUNT = 1_030;
const WARMUP_FRAMES = 120;
const MEASURED_FRAMES = 600;
const ROUNDS = 5;
const FRAME_MS = 1000 / 60;
const ARENA_EXTENT = 2_448;
const RULES = { starFoodValue: 10 } as const;
const VIEW = { left: -900, top: -750, right: 900, bottom: 750 } as const;
const FAR_HEAD = { x: 10_000, y: 10_000 } as const;
const TEXTURES = {
  dots: [Texture.EMPTY],
  star: Texture.EMPTY,
  candy: [Texture.EMPTY],
} as const;

function makeFoods(): ReadonlyArray<FoodState> {
  return Array.from({ length: FOOD_COUNT }, (_, id): FoodState => {
    const star = id % 10 === 0;
    const x = ((id * 193) % (ARENA_EXTENT * 2)) - ARENA_EXTENT;
    const y = ((id * 347 + 811) % (ARENA_EXTENT * 2)) - ARENA_EXTENT;
    return {
      id,
      position: { x, y },
      value: star ? 10 : 1,
      lengthValue: star ? 10 : 1,
      variant: id % 7,
      generation: id % 13 === 0 ? 1 : 0,
      motion: star
        ? {
            directionDegrees: (id * 29) % 360,
            linearFramesRemaining: 140 + (id % 40),
          }
        : undefined,
      kind: "ambient",
    };
  });
}

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}
function assertContactSemantics(): void {
  const layer = new FoodLayer(RULES, TEXTURES);
  const contactFood: FoodState = {
    id: 99_999,
    position: { x: 0, y: 0 },
    value: 1,
    lengthValue: 1,
    variant: 0,
    generation: 0,
    kind: "ambient",
  };
  layer.sync([contactFood], VIEW, 114, [contactFood]);
  expect(
    layer.predictSelfContacts(
      "self",
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      18,
      1.6,
      0,
      120,
      120,
    ),
  ).toEqual([contactFood]);

  const event: FoodConsumedEvent = {
    playerId: "self",
    sourceFrame: 120,
    food: contactFood,
    target: { x: 0, y: 0 },
  };
  expect(layer.startAbsorb(event)).toBe(true);
  for (let sourceFrame = 120; sourceFrame <= 132; sourceFrame += 1) {
    layer.update(VIEW, () => sourceFrame, () => ({ x: 0, y: 0 }));
  }
  expect(layer.positionOf(contactFood.id)).toBeUndefined();
  layer.destroy();
}


function runRound(foods: ReadonlyArray<FoodState>): {
  elapsedMs: number;
  checksum: number;
  predictedContacts: number;
  visibleSample: number;
} {
  const layer = new FoodLayer(RULES, TEXTURES);
  const moving = new MovingFoodPresentation();
  let checksum = 0;
  let predictedContacts = 0;
  let visibleSample = 0;

  const runFrame = (frame: number): void => {
    // GameRenderer displays at 60Hz while the authoritative game tick is 20Hz
    // (three presentation frames per authoritative source-frame group).
    const authoritativeSourceFrame = Math.floor(frame / 3) * 3;
    const presentationSourceFrame = authoritativeSourceFrame + (frame % 3) + 0.5;
    // This is the same per-frame map performed by GameRenderer before the
    // moving-food and FoodLayer stages. It intentionally includes static food.
    const presentedFoods = foods.map((food) => {
      const position = predictFoodPresentationPosition(
        food,
        authoritativeSourceFrame,
        presentationSourceFrame,
        ARENA_EXTENT,
        foodRadiusOf(food, RULES),
      );
      return position === undefined ? food : { ...food, position };
    });
    const smoothedFoods = moving.sample(presentedFoods, FRAME_MS);
    layer.sync(smoothedFoods, VIEW, authoritativeSourceFrame, foods);
    predictedContacts += layer.predictSelfContacts(
      "self",
      FAR_HEAD,
      FAR_HEAD,
      18,
      1.6,
      0,
      presentationSourceFrame,
      Math.ceil(presentationSourceFrame),
    ).length;
    layer.update(VIEW, () => presentationSourceFrame, () => FAR_HEAD);

    const sample = smoothedFoods[(frame * 17) % smoothedFoods.length];
    if (sample !== undefined) {
      checksum += sample.position.x * 0.0001 + sample.position.y * 0.00001;
    }
    if (frame % 61 === 0) {
      const record = layer.positionOf((frame * 31) % FOOD_COUNT);
      if (record !== undefined) {
        checksum += record.x * 0.000001 + record.y * 0.0000001;
        if (
          record.x > VIEW.left &&
          record.x < VIEW.right &&
          record.y > VIEW.top &&
          record.y < VIEW.bottom
        ) {
          visibleSample += 1;
        }
      }
    }
  };

  for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) runFrame(frame);
  const started = performance.now();
  for (let frame = WARMUP_FRAMES; frame < WARMUP_FRAMES + MEASURED_FRAMES; frame += 1) {
    runFrame(frame);
  }
  const elapsedMs = performance.now() - started;
  layer.destroy();
  return { elapsedMs, checksum, predictedContacts, visibleSample };
}

describe("client food pipeline benchmark", () => {
  it("measures the real headless food presentation path", () => {
    const foods = makeFoods();
    // Warm one independent run so module/JIT startup is not the measured target.
    runRound(foods);

    const samples: number[] = [];
    let checksum = 0;
    let predictedContacts = 0;
    let visibleSample = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const result = runRound(foods);
      samples.push((result.elapsedMs * 1_000) / MEASURED_FRAMES);
      checksum += result.checksum;
      predictedContacts += result.predictedContacts;
      visibleSample += result.visibleSample;
    }

    const primary = median(samples);
    const sorted = [...samples].sort((left, right) => left - right);
    const p95 = sorted[sorted.length - 1] ?? Number.NaN;
    const minimum = sorted[0] ?? Number.NaN;
    expect(Number.isFinite(primary)).toBe(true);
    expect(predictedContacts).toBe(0);
    assertContactSemantics();
    expect(Number.isFinite(checksum)).toBe(true);
    expect(visibleSample).toBeGreaterThanOrEqual(0);

    console.log(`METRIC client_food_pipeline_us_per_frame=${primary.toFixed(3)}`);
    console.log(`METRIC client_food_pipeline_p95_us_per_frame=${p95.toFixed(3)}`);
    console.log(`METRIC client_food_pipeline_min_us_per_frame=${minimum.toFixed(3)}`);
    console.log(`METRIC food_checksum=${checksum.toFixed(6)}`);
    console.log(`METRIC predicted_contacts_total=${predictedContacts}`);
    console.log(`METRIC visible_records_sample=${visibleSample}`);
  }, 120_000);
});
