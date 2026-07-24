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

const CORRECTION_ANGULAR_FREQUENCY = 30;
const CORRECTION_EPSILON = 1e-4;

/**
 * Presentation-only offset for an authoritative position correction.
 *
 * Applying the inverse translation keeps the corrected frame continuous. A
 * critically damped spring then converges to zero without changing velocity
 * when another snapshot correction arrives.
 */
export class PositionCorrectionSmoother {
  offsetX = 0;
  offsetY = 0;
  private velocityX = 0;
  private velocityY = 0;

  preserveAfterTranslation(x: number, y: number): void {
    this.offsetX -= x;
    this.offsetY -= y;
  }

  advance(deltaMs: number): void {
    const seconds = Math.min(0.25, Math.max(0, deltaMs / 1000));
    if (seconds === 0) return;

    const decay = Math.exp(-CORRECTION_ANGULAR_FREQUENCY * seconds);
    const xTerm = this.velocityX + CORRECTION_ANGULAR_FREQUENCY * this.offsetX;
    const yTerm = this.velocityY + CORRECTION_ANGULAR_FREQUENCY * this.offsetY;
    this.offsetX = (this.offsetX + xTerm * seconds) * decay;
    this.offsetY = (this.offsetY + yTerm * seconds) * decay;
    this.velocityX = (this.velocityX - CORRECTION_ANGULAR_FREQUENCY * xTerm * seconds) * decay;
    this.velocityY = (this.velocityY - CORRECTION_ANGULAR_FREQUENCY * yTerm * seconds) * decay;

    if (Math.abs(this.offsetX) < CORRECTION_EPSILON && Math.abs(this.velocityX) < 0.001) {
      this.offsetX = 0;
      this.velocityX = 0;
    }
    if (Math.abs(this.offsetY) < CORRECTION_EPSILON && Math.abs(this.velocityY) < 0.001) {
      this.offsetY = 0;
      this.velocityY = 0;
    }
  }

  reset(): void {
    this.offsetX = 0;
    this.offsetY = 0;
    this.velocityX = 0;
    this.velocityY = 0;
  }
}
