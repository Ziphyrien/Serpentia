import type { GameSnapshot } from "$lib/protocol";
import { skinForPlayer } from "../config";

/**
 * 小地图：独立 2D canvas，低频刷新。
 * 与 Pixi 场景完全解耦，只读快照数据。
 */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D | undefined;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly halfSize: number,
  ) {
    this.ctx = canvas.getContext("2d") ?? undefined;
  }

  render(snapshot: GameSnapshot | undefined, selfId: string | undefined): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    if (!snapshot) return;

    const padding = 6;
    const scale = (Math.min(width, height) - padding * 2) / (this.halfSize * 2);
    const toX = (x: number): number => width / 2 + x * scale;
    const toY = (y: number): number => height / 2 + y * scale;

    // 场地区域与边框
    ctx.fillStyle = "rgba(21, 29, 61, 0.55)";
    ctx.fillRect(
      toX(-this.halfSize),
      toY(-this.halfSize),
      this.halfSize * 2 * scale,
      this.halfSize * 2 * scale,
    );
    ctx.strokeStyle = "rgba(61, 220, 132, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      toX(-this.halfSize),
      toY(-this.halfSize),
      this.halfSize * 2 * scale,
      this.halfSize * 2 * scale,
    );

    // 食物（抽样，避免过量绘制）
    ctx.fillStyle = "rgba(255, 243, 248, 0.5)";
    const step = Math.max(1, Math.floor(snapshot.foods.length / 160));
    for (let index = 0; index < snapshot.foods.length; index += step) {
      const food = snapshot.foods[index];
      ctx.fillRect(toX(food.position.x) - 0.5, toY(food.position.y) - 0.5, 1.5, 1.5);
    }

    // 蛇
    for (const snake of snapshot.snakes) {
      if (!snake.alive) continue;
      const isSelf = snake.id === selfId;
      ctx.strokeStyle = isSelf ? "#ffffff" : skinForPlayer(snake.id).minimap;
      ctx.lineWidth = isSelf ? 3 : 2.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      const stride = Math.max(1, Math.floor(snake.body.length / 40));
      for (let index = 0; index < snake.body.length; index += stride) {
        const point = snake.body[index];
        if (index === 0) ctx.moveTo(toX(point.x), toY(point.y));
        else ctx.lineTo(toX(point.x), toY(point.y));
      }
      ctx.stroke();
      if (isSelf && snake.body.length > 0) {
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(toX(snake.body[0].x), toY(snake.body[0].y), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
