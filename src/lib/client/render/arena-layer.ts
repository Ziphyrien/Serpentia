import { Container, Graphics } from "pixi.js";
import { ARENA_COLORS } from "../config";

/** 网格最小格边长（世界单位），约为蛇基础直径的两倍。 */
const MINOR_CELL = 46;
/** 每隔多少小格加粗一条主网格线。 */
const MAJOR_EVERY = 4;
const MINOR_WIDTH = 1.5;
const MAJOR_WIDTH = 3;

/**
 * 场地层：全部由矢量几何绘制，任意相机缩放下都保持锐利。
 * 边界靠亮色场地与深色场外的对比呈现，不额外画墙线。
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

  gfx.rect(-halfSize, -halfSize, halfSize * 2, halfSize * 2).fill(ARENA_COLORS.floor);
  drawGrid(gfx, halfSize);

  return gfx;
}

/**
 * 网格线用填充矩形绘制，同粗细的线合并成一次 fill：
 * 既避免描边接头，也把整片网格压到两条绘制指令。
 */
function drawGrid(gfx: Graphics, halfSize: number): void {
  const size = halfSize * 2;
  const addLine = (offset: number, width: number): void => {
    const start = offset - width / 2;
    gfx.rect(start, -halfSize, width, size);
    gfx.rect(-halfSize, start, size, width);
  };

  for (let step = 1; step * MINOR_CELL < halfSize; step += 1) {
    if (step % MAJOR_EVERY === 0) continue;
    for (const sign of [-1, 1]) addLine(sign * step * MINOR_CELL, MINOR_WIDTH);
  }
  gfx.fill(ARENA_COLORS.gridMinor);

  // 中轴线与主网格线同色，给出场地中心的方位参考
  addLine(0, MAJOR_WIDTH);
  for (let step = MAJOR_EVERY; step * MINOR_CELL < halfSize; step += MAJOR_EVERY) {
    for (const sign of [-1, 1]) addLine(sign * step * MINOR_CELL, MAJOR_WIDTH);
  }
  gfx.fill(ARENA_COLORS.gridMajor);
}
