import { Container, Graphics, Sprite, type Texture } from "pixi.js";
import type { FoodState } from "$lib/protocol";
import { FOOD_TEXTURE_CONTENT } from "./assets";

interface ViewBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface FoodRecord {
  sprite: Sprite | undefined;
  fallback: Graphics | undefined;
  x: number;
  y: number;
  kind: FoodState["kind"];
  baseScale: number;
  phase: number;
}

/**
 * 食物层：精灵对象池 + 视口裁剪 + 呼吸动画。
 * 无纹理时降级为程序化发光圆点。
 */
export class FoodLayer {
  readonly container = new Container();
  private records = new Map<number, FoodRecord>();
  private readonly textureSize: number;

  constructor(
    private readonly pearl: Texture | undefined,
    private readonly gold: Texture | undefined,
    private readonly foodRadius: number,
  ) {
    this.textureSize = pearl?.width ?? 1024;
  }

  /** 供特效/音效查询食物最后已知位置。 */
  positionOf(foodId: number): { x: number; y: number; kind: FoodState["kind"] } | undefined {
    const record = this.records.get(foodId);
    return record ? { x: record.x, y: record.y, kind: record.kind } : undefined;
  }

  sync(foods: ReadonlyArray<FoodState>, view: ViewBounds, nowMs: number): void {
    const seen = new Set<number>();
    for (const food of foods) {
      seen.add(food.id);
      let record = this.records.get(food.id);
      if (!record) {
        record = this.createRecord(food);
        this.records.set(food.id, record);
      }
      record.x = food.position.x;
      record.y = food.position.y;
      const node = record.sprite ?? record.fallback;
      if (!node) continue;
      const visible =
        food.position.x > view.left &&
        food.position.x < view.right &&
        food.position.y > view.top &&
        food.position.y < view.bottom;
      node.visible = visible;
      if (visible) {
        node.position.set(food.position.x, food.position.y);
        const pulse = 1 + Math.sin(nowMs * 0.004 + record.phase) * 0.12;
        if (record.sprite) record.sprite.scale.set(record.baseScale * pulse);
        else record.fallback?.scale.set(record.baseScale * pulse);
      }
    }
    for (const [id, record] of this.records) {
      if (!seen.has(id)) {
        record.sprite?.destroy();
        record.fallback?.destroy();
        this.records.delete(id);
      }
    }
  }

  remove(foodId: number): void {
    const record = this.records.get(foodId);
    if (!record) return;
    record.sprite?.destroy();
    record.fallback?.destroy();
    this.records.delete(foodId);
  }

  destroy(): void {
    for (const record of this.records.values()) {
      record.sprite?.destroy();
      record.fallback?.destroy();
    }
    this.records.clear();
  }

  private createRecord(food: FoodState): FoodRecord {
    // 尺寸随价值增大；尸体食物（remains）偏暖色
    const sizeFactor = Math.min(1.9, 0.75 + food.value * 0.09);
    const desiredDiameter = this.foodRadius * 2 * sizeFactor;
    const phase = (food.id * 7919) % (Math.PI * 2);

    const texture = food.kind === "boost" ? (this.gold ?? this.pearl) : this.pearl;
    if (texture) {
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      const baseScale = desiredDiameter / (this.textureSize * FOOD_TEXTURE_CONTENT);
      sprite.scale.set(baseScale);
      if (food.kind === "remains") sprite.tint = 0xffc27a;
      this.container.addChild(sprite);
      return { sprite, fallback: undefined, x: food.position.x, y: food.position.y, kind: food.kind, baseScale, phase };
    }

    // 降级：程序化光点
    const color = food.kind === "boost" ? 0xffd75e : food.kind === "remains" ? 0xffc27a : 0xfff3f8;
    const fallback = new Graphics();
    const radius = desiredDiameter / 2;
    fallback.circle(0, 0, radius * 1.9).fill({ color, alpha: 0.18 });
    fallback.circle(0, 0, radius).fill({ color });
    fallback.circle(-radius * 0.25, -radius * 0.25, radius * 0.35).fill({ color: 0xffffff, alpha: 0.9 });
    const baseScale = 1;
    this.container.addChild(fallback);
    return { sprite: undefined, fallback, x: food.position.x, y: food.position.y, kind: food.kind, baseScale, phase };
  }
}
