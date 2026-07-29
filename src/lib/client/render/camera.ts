import { RENDER } from "../config";

/** 相机缩放系数：单位逻辑长度对应的缩放衰减。 */
const SCALE_FACTOR = (RENDER.cameraInitScale - RENDER.cameraMinScale) / RENDER.cameraScaleMaxLength;

/**
 * 相机：跟随蛇头，缩放随逻辑长度线性衰减。
 *
 * 世界单位到屏幕像素分两级：先按固定高度设计分辨率折算，再乘相机缩放。
 * 这样所有屏幕的纵向视野一致，横向视野随宽高比自然增减。
 */
export class Camera {
  x = 0;
  y = 0;
  /** 相机缩放，直接对应设计像素与世界单位的比例。 */
  zoom: number = RENDER.cameraInitScale;

  /** 缩放只由逻辑长度决定，位置直接跟随蛇头，均不做平滑。 */
  update(targetX: number, targetY: number, length: number): void {
    this.x = targetX;
    this.y = targetY;
    this.zoom =
      length < RENDER.cameraScaleMaxLength
        ? RENDER.cameraInitScale - length * SCALE_FACTOR
        : RENDER.cameraMinScale;
  }

  reset(): void {
    this.zoom = RENDER.cameraInitScale;
  }

  /**
   * 固定高度设计分辨率：原版 `cc.Canvas` 使用 `fitHeight=true`、`fitWidth=false`。
   * 屏幕高度始终映射为 750 设计单位，宽高比只改变左右可见世界。
   */
  worldScale(screenWidth: number, screenHeight: number): number {
    return pixelsPerDesignUnit(screenWidth, screenHeight) * this.zoom;
  }

  /** 当前视野的世界坐标范围（含边距），供视口裁剪。 */
  viewBounds(
    screenWidth: number,
    screenHeight: number,
    margin = 80,
  ): {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } {
    const scale = this.worldScale(screenWidth, screenHeight);
    const halfW = screenWidth / 2 / scale + margin;
    const halfH = screenHeight / 2 / scale + margin;
    return {
      left: this.x - halfW,
      top: this.y - halfH,
      right: this.x + halfW,
      bottom: this.y + halfH,
    };
  }
}

/**
 * 原版正常 `Game` 的 `cc.Canvas` 固定高度适配倍率。
 *
 * Canvas 默认 `fitHeight=true`、`fitWidth=false`，所以不论屏幕宽高比如何，
 * 750 个设计单位始终占满屏幕高度；更宽的屏幕只会显示更多左右世界。
 */
export function pixelsPerDesignUnit(_screenWidth: number, screenHeight: number): number {
  return screenHeight / RENDER.designHeight;
}
