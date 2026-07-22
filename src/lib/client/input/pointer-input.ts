import type { InputState } from "./input-state";

/**
 * 桌面端输入：鼠标相对屏幕中心的方向 + 左键/空格加速。
 * 只负责把 DOM 事件翻译成 InputState。
 */
export class PointerInput {
  private disposed = false;

  constructor(private readonly state: InputState) {
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp, { passive: true });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("contextmenu", this.onContextMenu);
  }

  private pointerActive = false;
  private keyActive = false;

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === "touch") return; // 触屏交给摇杆
    const dx = event.clientX - window.innerWidth / 2;
    const dy = event.clientY - window.innerHeight / 2;
    if (dx * dx + dy * dy < 4) return; // 中心死区，避免抖动
    this.state.angle = Math.atan2(dy, dx);
    this.state.hasDirection = true;
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "touch" || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, a, input, [data-ui]")) return; // 不抢 UI 点击
    this.pointerActive = true;
    this.state.boosting = true;
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === "touch" || event.button !== 0) return;
    this.pointerActive = false;
    this.state.boosting = this.keyActive;
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== "Space" || event.repeat) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea")) return;
    event.preventDefault();
    this.keyActive = true;
    this.state.boosting = true;
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== "Space") return;
    this.keyActive = false;
    this.state.boosting = this.pointerActive;
  };

  private onBlur = (): void => {
    this.pointerActive = false;
    this.keyActive = false;
    this.state.boosting = false;
  };

  private onContextMenu = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest("input, [data-ui]")) event.preventDefault();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("contextmenu", this.onContextMenu);
  }
}
