import { Container, Sprite, type Texture } from "pixi.js";
import type { FoodState } from "$lib/protocol";

interface ViewBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface FoodRecord {
  node: Sprite;
  x: number;
  y: number;
  kind: FoodState["kind"];
}

const NO_HIDDEN_FOODS: ReadonlySet<number> = new Set();

/**
 * 食物层：直接使用 Snake-Demo 的 8 张 node Sprite；尸体食物使用原版 deadfood Sprite。
 * 普通食物与死亡食物的 1:1.875 尺寸比来自原 Unity Prefab。
 */
export class FoodLayer {
  readonly container = new Container();
  private readonly records = new Map<number, FoodRecord>();

  constructor(
    private readonly foodRadius: number,
    private readonly foodTextures: ReadonlyArray<Texture>,
    private readonly remainsTexture: Texture,
  ) {
    if (foodTextures.length === 0) throw new Error("Snake-Demo food textures are missing");
  }

  /** 供特效/音效查询食物最后已知位置。 */
  positionOf(foodId: number): { x: number; y: number; kind: FoodState["kind"] } | undefined {
    const record = this.records.get(foodId);
    return record ? { x: record.x, y: record.y, kind: record.kind } : undefined;
  }

  sync(
    foods: ReadonlyArray<FoodState>,
    view: ViewBounds,
    hiddenFoodIds: ReadonlySet<number> = NO_HIDDEN_FOODS,
  ): void {
    const seen = new Set<number>();
    for (const food of foods) {
      seen.add(food.id);
      let record = this.records.get(food.id);
      if (!record || record.kind !== food.kind) {
        record?.node.destroy();
        record = this.createRecord(food);
        this.records.set(food.id, record);
      }

      record.x = food.position.x;
      record.y = food.position.y;
      const margin = food.kind === "remains" ? this.foodRadius * 2 : this.foodRadius;
      const visible =
        !hiddenFoodIds.has(food.id) &&
        food.position.x > view.left - margin &&
        food.position.x < view.right + margin &&
        food.position.y > view.top - margin &&
        food.position.y < view.bottom + margin;
      record.node.visible = visible;
      if (visible) record.node.position.set(food.position.x, food.position.y);
    }

    for (const [id, record] of this.records) {
      if (!seen.has(id)) {
        record.node.destroy();
        this.records.delete(id);
      }
    }
  }

  remove(foodId: number): void {
    const record = this.records.get(foodId);
    if (!record) return;
    record.node.destroy();
    this.records.delete(foodId);
  }

  destroy(): void {
    for (const record of this.records.values()) record.node.destroy();
    this.records.clear();
  }

  private createRecord(food: FoodState): FoodRecord {
    const texture = this.textureFor(food);
    const node = new Sprite({ texture, anchor: 0.5 });
    // 原版普通食物为 16×16；deadfood 为约 60×62 并以 0.5 倍生成。
    const diameter = this.foodRadius * (food.kind === "remains" ? 3.75 : 2);
    node.scale.set(diameter / Math.max(texture.width, texture.height));
    this.container.addChild(node);

    return {
      node,
      x: food.position.x,
      y: food.position.y,
      kind: food.kind,
    };
  }

  private textureFor(food: FoodState): Texture {
    if (food.kind === "remains") return this.remainsTexture;
    const texture = this.foodTextures[food.id % this.foodTextures.length];
    if (!texture) throw new Error("Snake-Demo food texture lookup failed");
    return texture;
  }
}
