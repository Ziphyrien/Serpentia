import { Container, Graphics, GraphicsContext } from "pixi.js";
import type { FoodState } from "$lib/protocol";

interface ViewBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface FoodRecord {
  node: Graphics;
  x: number;
  y: number;
  kind: FoodState["kind"];
}

interface FoodPalette {
  /** 外圈光晕 */
  glow: number;
  /** 球体主色 */
  base: number;
  /** 底部暗面 */
  shade: number;
}

const NO_HIDDEN_FOODS: ReadonlySet<number> = new Set();
const PALETTES: Record<FoodState["kind"], FoodPalette> = {
  ambient: { glow: 0xffc9e2, base: 0xfff3f8, shade: 0xf0a8cd },
  boost: { glow: 0xffe9a8, base: 0xffd75e, shade: 0xeda03a },
  remains: { glow: 0xffd2a0, base: 0xffc27a, shade: 0xe88a3c },
};

/**
 * 食物层：程序化绘制的固定尺寸糖珠，保留柔和暗面但不带高光与缩放动画。
 * 加速食物（boost）通过倾斜光环区分。
 */
export class FoodLayer {
  readonly container = new Container();
  private records = new Map<number, FoodRecord>();
  private contexts = new Map<string, GraphicsContext>();

  constructor(private readonly foodRadius: number) {}

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
      if (!record) {
        record = this.createRecord(food);
        this.records.set(food.id, record);
      }
      record.x = food.position.x;
      record.y = food.position.y;
      const visible =
        !hiddenFoodIds.has(food.id) &&
        food.position.x > view.left &&
        food.position.x < view.right &&
        food.position.y > view.top &&
        food.position.y < view.bottom;
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
    for (const context of this.contexts.values()) context.destroy();
    this.contexts.clear();
  }

  private createRecord(food: FoodState): FoodRecord {
    // 尺寸随价值增大；尸体食物（remains）偏暖色
    const sizeFactor = Math.min(1.9, 0.75 + food.value * 0.09);
    const radius = this.foodRadius * sizeFactor;
    const node = new Graphics(this.contextFor(food.kind, radius));
    if (food.kind === "boost") node.rotation = -0.5;

    this.container.addChild(node);
    return {
      node,
      x: food.position.x,
      y: food.position.y,
      kind: food.kind,
    };
  }

  private contextFor(kind: FoodState["kind"], radius: number): GraphicsContext {
    const key = `${kind}:${radius}`;
    const existing = this.contexts.get(key);
    if (existing) return existing;

    const palette = PALETTES[kind];
    const context = new GraphicsContext();
    // 光晕
    context.circle(0, 0, radius * 2).fill({ color: palette.glow, alpha: 0.14 });
    context.circle(0, 0, radius * 1.45).fill({ color: palette.glow, alpha: 0.22 });
    // 球体：主色 + 底部暗面
    context.circle(0, 0, radius).fill(palette.base);
    context.circle(0, radius * 0.22, radius * 0.8).fill({ color: palette.shade, alpha: 0.5 });
    // 加速食物：倾斜光环
    if (kind === "boost") {
      context
        .ellipse(0, 0, radius * 1.7, radius * 0.62)
        .stroke({ width: Math.max(1.5, radius * 0.16), color: 0xffedb0, alpha: 0.85 });
    }

    this.contexts.set(key, context);
    return context;
  }
}
