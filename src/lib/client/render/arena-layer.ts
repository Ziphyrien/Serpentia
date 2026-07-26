import { Container, Graphics, TilingSprite, type Texture } from "pixi.js";
import { ARENA_COLORS } from "../config";

/**
 * Snake-Demo 场地：原版浅灰三角纹理铺在世界空间，场地外使用原版纯红底色。
 * 不再叠加当前项目原有的星空、绿色边框或视差效果。
 */
export class ArenaLayer {
  readonly screenContainer = new Container();
  readonly worldContainer = new Container();

  private readonly outside = new Graphics();
  private readonly background: TilingSprite | Graphics;

  constructor(arenaBackground: Texture | undefined, halfSize: number) {
    this.screenContainer.addChild(this.outside);

    const size = halfSize * 2;
    if (arenaBackground) {
      const background = new TilingSprite({
        texture: arenaBackground,
        width: size,
        height: size,
      });
      background.position.set(-halfSize, -halfSize);
      // 原工程为 100 PPU、场地宽 27.32；按当前场地宽度等比映射后保持原纹理比例。
      background.tileScale.set(size / arenaBackground.width);
      this.background = background;
    } else {
      this.background = new Graphics()
        .rect(-halfSize, -halfSize, size, size)
        .fill(ARENA_COLORS.fallback);
    }
    this.worldContainer.addChild(this.background);
  }

  resize(width: number, height: number): void {
    this.outside.clear().rect(0, 0, width, height).fill(ARENA_COLORS.outside);
  }
}
