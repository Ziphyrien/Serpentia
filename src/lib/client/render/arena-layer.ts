import { Container, Graphics, TilingSprite, type Texture } from "pixi.js";
import { ARENA_COLORS } from "../config";
import type { Camera } from "./camera";

/**
 * 场地层：屏幕空间的星空平铺背景 + 世界空间的边界墙。
 * 背景随相机平移制造视差，边界只在初始化时绘制一次。
 */
export class ArenaLayer {
  readonly screenContainer = new Container();
  readonly worldContainer = new Container();

  private background: TilingSprite | undefined;
  private fallbackBackground: Graphics | undefined;
  private boundary: Graphics;

  constructor(
    bgTile: Texture | undefined,
    private readonly halfSize: number,
  ) {
    if (bgTile) {
      this.background = new TilingSprite({ texture: bgTile, width: 1, height: 1 });
      this.background.tileScale.set(0.5);
      this.screenContainer.addChild(this.background);
    } else {
      this.fallbackBackground = new Graphics().rect(0, 0, 1, 1).fill(0x101736);
      this.screenContainer.addChild(this.fallbackBackground);
    }

    this.boundary = new Graphics();
    const size = halfSize * 2;
    // 场内微亮底色，让场内/场外有区分
    this.boundary.rect(-halfSize, -halfSize, size, size).fill({ color: 0x151d3d, alpha: 0.35 });
    // 外圈辉光 + 内圈亮线
    this.boundary
      .rect(-halfSize, -halfSize, size, size)
      .stroke({ width: 26, color: ARENA_COLORS.borderGlow, alpha: 0.5 });
    this.boundary
      .rect(-halfSize, -halfSize, size, size)
      .stroke({ width: 6, color: ARENA_COLORS.border, alpha: 0.95 });
    this.worldContainer.addChild(this.boundary);
  }

  resize(width: number, height: number): void {
    if (this.background) {
      this.background.width = width;
      this.background.height = height;
    }
    if (this.fallbackBackground) {
      this.fallbackBackground.clear().rect(0, 0, width, height).fill(0x101736);
    }
  }

  update(camera: Camera): void {
    if (this.background) {
      // 轻微视差：背景以 0.5 倍速率跟随相机
      this.background.tilePosition.x = -camera.x * camera.zoom * 0.5;
      this.background.tilePosition.y = -camera.y * camera.zoom * 0.5;
    }
  }
}
