import { RENDER } from "../config";

/** 相机：平滑跟随目标点，缩放随蛇半径变化（越大视野越广）。 */
export class Camera {
  x = 0;
  y = 0;
  zoom: number = RENDER.zoomAtBaseRadius;
  private targetZoom: number = RENDER.zoomAtBaseRadius;
  private initialized = false;

  update(targetX: number, targetY: number, radius: number, dtMs: number): void {
    if (!this.initialized) {
      this.x = targetX;
      this.y = targetY;
      this.initialized = true;
    }
    const t = Math.min(1, Math.max(0, (radius - 11) / (30 - 11)));
    this.targetZoom =
      RENDER.zoomAtBaseRadius + (RENDER.zoomAtMaxRadius - RENDER.zoomAtBaseRadius) * t;

    const lerp = 1 - Math.pow(1 - RENDER.cameraLerp, dtMs / 16.7);
    this.x += (targetX - this.x) * lerp;
    this.y += (targetY - this.y) * lerp;
    this.zoom += (this.targetZoom - this.zoom) * lerp * 0.7;
  }

  reset(): void {
    this.initialized = false;
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
    const halfW = screenWidth / 2 / this.zoom + margin;
    const halfH = screenHeight / 2 / this.zoom + margin;
    return {
      left: this.x - halfW,
      top: this.y - halfH,
      right: this.x + halfW,
      bottom: this.y + halfH,
    };
  }
}
