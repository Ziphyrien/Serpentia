import { Container, Graphics } from "pixi.js";
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
  baseScale: number;
  phase: number;
}

interface FoodPalette {
  /** 外圈光晕 */
  glow: number;
  /** 球体主色 */
  base: number;
  /** 底部暗面 */
  shade: number;
  /** 顶部亮面 */
  top: number;
}

const NO_HIDDEN_FOODS: ReadonlySet<number> = new Set();
const PALETTES: Record<FoodState["kind"], FoodPalette> = {
  ambient: { glow: 0xffc9e2, base: 0xfff3f8, shade: 0xf0a8cd, top: 0xffffff },
  boost: { glow: 0xffe9a8, base: 0xffd75e, shade: 0xeda03a, top: 0xfff6d8 },
  remains: { glow: 0xffd2a0, base: 0xffc27a, shade: 0xe88a3c, top: 0xffe8cc },
};

/** 画一颗四角星形闪光。 */
function drawSparkle(
  gfx: Graphics,
  x: number,
  y: number,
  size: number,
  color: number,
  alpha: number,
): void {
  const k = 0.22;
  gfx
    .poly(
      [
        x,
        y - size,
        x + size * k,
        y - size * k,
        x + size,
        y,
        x + size * k,
        y + size * k,
        x,
        y + size,
        x - size * k,
        y + size * k,
        x - size,
        y,
        x - size * k,
        y - size * k,
      ],
      true,
    )
    .fill({ color, alpha });
}

/**
 * 食物层：程序化绘制的糖珠——径向光泽球体 + 闪光，
 * 加速食物（boost）带倾斜光环；视口裁剪 + 呼吸缩放动画。
 */
export class FoodLayer {
  readonly container = new Container();
  private records = new Map<number, FoodRecord>();

  constructor(private readonly foodRadius: number) {}

  /** 供特效/音效查询食物最后已知位置。 */
  positionOf(foodId: number): { x: number; y: number; kind: FoodState["kind"] } | undefined {
    const record = this.records.get(foodId);
    return record ? { x: record.x, y: record.y, kind: record.kind } : undefined;
  }

  sync(
    foods: ReadonlyArray<FoodState>,
    view: ViewBounds,
    nowMs: number,
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
      if (visible) {
        record.node.position.set(food.position.x, food.position.y);
        const pulse = 1 + Math.sin(nowMs * 0.004 + record.phase) * 0.12;
        record.node.scale.set(record.baseScale * pulse);
      }
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
    // 尺寸随价值增大；尸体食物（remains）偏暖色
    const sizeFactor = Math.min(1.9, 0.75 + food.value * 0.09);
    const radius = this.foodRadius * sizeFactor;
    const palette = PALETTES[food.kind];
    const node = new Graphics();

    // 光晕
    node.circle(0, 0, radius * 2).fill({ color: palette.glow, alpha: 0.14 });
    node.circle(0, 0, radius * 1.45).fill({ color: palette.glow, alpha: 0.22 });
    // 球体：主色 + 底部暗面 + 顶部亮面，模拟径向光泽
    node.circle(0, 0, radius).fill(palette.base);
    node.circle(0, radius * 0.22, radius * 0.8).fill({ color: palette.shade, alpha: 0.5 });
    node.circle(0, -radius * 0.26, radius * 0.6).fill({ color: palette.top, alpha: 0.95 });
    // 高光点 + 星形闪光
    node
      .circle(-radius * 0.3, -radius * 0.36, radius * 0.18)
      .fill({ color: 0xffffff, alpha: 0.95 });
    drawSparkle(node, radius * 0.4, -radius * 0.52, radius * 0.32, 0xffffff, 0.9);
    // 加速食物：倾斜光环（整体旋转一点点，闪光随动无伤大雅）
    if (food.kind === "boost") {
      drawSparkle(node, -radius * 0.62, radius * 0.55, radius * 0.22, 0xffffff, 0.75);
      node
        .ellipse(0, 0, radius * 1.7, radius * 0.62)
        .stroke({ width: Math.max(1.5, radius * 0.16), color: 0xffedb0, alpha: 0.85 });
      node.rotation = -0.5;
    }

    this.container.addChild(node);
    return {
      node,
      x: food.position.x,
      y: food.position.y,
      kind: food.kind,
      baseScale: 1,
      phase: (food.id * 7919) % (Math.PI * 2),
    };
  }
}
