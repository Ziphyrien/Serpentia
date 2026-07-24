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

interface TimedPositionCorrection {
  readonly x: number;
  readonly y: number;
  readonly startedAt: number;
}

const POSITION_CORRECTION_DURATION_MS = 160;

/**
 * Presentation-only offset for authoritative position corrections.
 *
 * Each inverse translation follows an independent minimum-jerk curve. Its
 * velocity and acceleration are both zero at the endpoints, so 10 Hz snapshot
 * arrivals cannot inject the acceleration pulses produced by a reset spring.
 */
export class PositionCorrectionSmoother {
  offsetX = 0;
  offsetY = 0;
  private readonly corrections: Array<TimedPositionCorrection> = [];

  preserveAfterTranslation(x: number, y: number, now: number): void {
    this.corrections.push({ x: -x, y: -y, startedAt: now });
    this.sample(now);
  }

  sample(now: number): void {
    let offsetX = 0;
    let offsetY = 0;
    let retained = 0;
    for (const correction of this.corrections) {
      const progress = Math.min(
        1,
        Math.max(0, (now - correction.startedAt) / POSITION_CORRECTION_DURATION_MS),
      );
      if (progress >= 1) continue;
      const squared = progress * progress;
      const cubed = squared * progress;
      const remaining = 1 - cubed * (10 + progress * (-15 + progress * 6));
      offsetX += correction.x * remaining;
      offsetY += correction.y * remaining;
      this.corrections[retained] = correction;
      retained += 1;
    }
    this.corrections.length = retained;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
  }

  reset(): void {
    this.corrections.length = 0;
    this.offsetX = 0;
    this.offsetY = 0;
  }
}
