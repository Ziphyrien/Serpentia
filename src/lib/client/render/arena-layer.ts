import { Container, Graphics } from "pixi.js";
import { ARENA_COLORS, ARENA_GEOMETRY } from "../config";

/**
 * 场地层：全部由矢量几何绘制，任意相机缩放下都保持锐利。
 *
 * 绘制顺序为场外底色、场地底色、网格、边框。
 */
export class ArenaLayer {
  readonly screenContainer = new Container();
  readonly worldContainer = new Container();

  private readonly surround = new Graphics();

  constructor(halfSize: number) {
    this.screenContainer.addChild(this.surround);
    this.worldContainer.addChild(buildField(halfSize));
  }

  resize(width: number, height: number): void {
    this.surround.clear().rect(0, 0, width, height).fill(ARENA_COLORS.surround);
  }
}

/** 静态场地几何只构建一次，之后每帧零重绘。 */
function buildField(halfSize: number): Graphics {
  const gfx = new Graphics();
  const size = halfSize * 2;

  gfx.rect(-halfSize, -halfSize, size, size).fill(ARENA_COLORS.floor);
  drawGrid(gfx, halfSize);
  drawBorder(gfx, halfSize);

  return gfx;
}

/** 均匀网格，间距与线宽固定，没有主次线之分。 */
function drawGrid(gfx: Graphics, halfSize: number): void {
  const { gridSpacing, gridLineWidth } = ARENA_GEOMETRY;

  for (let offset = -halfSize + gridSpacing; offset < halfSize; offset += gridSpacing) {
    gfx.moveTo(offset, -halfSize).lineTo(offset, halfSize);
    gfx.moveTo(-halfSize, offset).lineTo(halfSize, offset);
  }
  gfx.stroke({ color: ARENA_COLORS.grid, width: gridLineWidth });
}

function drawBorder(gfx: Graphics, halfSize: number): void {
  const { borderWidth, borderOutset } = ARENA_GEOMETRY;
  const start = -halfSize - borderOutset;
  const size = halfSize * 2 + borderOutset * 2;

  gfx.rect(start, start, size, size).stroke({ color: ARENA_COLORS.border, width: borderWidth });
}
