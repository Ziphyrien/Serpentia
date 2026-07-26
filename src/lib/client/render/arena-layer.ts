import { Container, Graphics } from "pixi.js";
import { ARENA_COLORS } from "../config";

/** 网格最小格边长（世界单位），约为蛇基础直径的两倍。 */
const MINOR_CELL = 46;
/** 每隔多少小格加粗一条主网格线。 */
const MAJOR_EVERY = 4;
const MINOR_WIDTH = 1.5;
const MAJOR_WIDTH = 3;

/** 墙体厚度，画在场地外侧，不占用可行走区域。 */
const WALL_WIDTH = 7;
/** 贴墙警示带纵深，与 nearBoundary 的提示距离同量级。 */
const DANGER_DEPTH = 180;
const DANGER_STEPS = 12;
const DANGER_ALPHA = 0.3;
/** 墙外光晕纵深，向虚空淡出。 */
const GLOW_DEPTH = 110;
const GLOW_STEPS = 11;
const GLOW_ALPHA = 0.42;

/**
 * 场地层：全部由矢量几何绘制，任意相机缩放下都保持锐利。
 * 场外是深色虚空，原版红只出现在墙体、墙外光晕和贴墙警示带上，
 * 不再整屏平涂红色。
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

  drawOuterGlow(gfx, halfSize);
  gfx.rect(-halfSize, -halfSize, halfSize * 2, halfSize * 2).fill(ARENA_COLORS.floor);
  drawGrid(gfx, halfSize);
  drawDangerBand(gfx, halfSize);
  drawWall(gfx, halfSize);

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

/** 贴墙警示：向内淡出的同心带，只在靠墙时明显，中场完全不受影响。 */
function drawDangerBand(gfx: Graphics, halfSize: number): void {
  const step = DANGER_DEPTH / DANGER_STEPS;
  for (let index = 0; index < DANGER_STEPS; index += 1) {
    // 二次衰减，避免出现一圈可见的硬边
    const strength = 1 - index / DANGER_STEPS;
    band(gfx, halfSize - (index + 0.5) * step, step, DANGER_ALPHA * strength * strength);
  }
}

/** 墙外光晕：向外淡出的红环，替代原来的整屏红底。 */
function drawOuterGlow(gfx: Graphics, halfSize: number): void {
  const step = GLOW_DEPTH / GLOW_STEPS;
  const wallOuter = halfSize + WALL_WIDTH;
  for (let index = 0; index < GLOW_STEPS; index += 1) {
    const strength = 1 - index / GLOW_STEPS;
    band(gfx, wallOuter + (index + 0.5) * step, step, GLOW_ALPHA * strength * strength);
  }
}

function drawWall(gfx: Graphics, halfSize: number): void {
  band(gfx, halfSize + WALL_WIDTH / 2, WALL_WIDTH, 1);
}

/**
 * 画一个以原点为中心的方环，用居中描边实现：
 * 环恰好覆盖 [half - width/2, half + width/2]，相邻带按 width 递进即可拼接。
 * 比“外框填充 + 内框 cut”省一半指令，也不依赖 cut() 只回溯两条指令的行为。
 * 半透明带额外加 1 个单位重叠，消除相邻带之间的抗锯齿发丝缝。
 */
function band(gfx: Graphics, half: number, width: number, alpha: number): void {
  if (alpha <= 0.002 || half <= 0) return;
  gfx.rect(-half, -half, half * 2, half * 2).stroke({
    width: alpha < 1 ? width + 1 : width,
    color: ARENA_COLORS.wall,
    alpha,
    alignment: 0.5,
  });
}
