/**
 * 伪横屏：设备处于竖屏且系统横屏锁定不可用（如 iOS Safari）时，
 * 用 CSS 把游戏画面宽高互换并顺时针旋转 90°，模拟横屏布局。
 * 用户向左旋转设备即可正常游玩；系统锁横屏成功时本模块保持关闭。
 */

/** 画面顺时针旋转 90° 后，把屏幕坐标系方向换算回游戏方向所需的角度补偿。 */
export const PSEUDO_LANDSCAPE_ANGLE_OFFSET = -Math.PI / 2;

/** 伪横屏激活时给输入方向角追加补偿，使“推向画面上方”仍然朝游戏上方。 */
export function compensatePseudoLandscapeAngle(angle: number, active: boolean): number {
  return active ? angle + PSEUDO_LANDSCAPE_ANGLE_OFFSET : angle;
}

export interface PseudoLandscapeEnvironment {
  readonly portrait: boolean;
  readonly coarsePointer: boolean;
  readonly orientationLockAvailable: boolean;
}

/** 仅在竖屏触屏设备且无法系统锁定横屏时才需要伪横屏。 */
export function shouldUsePseudoLandscape(environment: PseudoLandscapeEnvironment): boolean {
  return environment.portrait && environment.coarsePointer && !environment.orientationLockAvailable;
}

export const pseudoLandscape = $state({ active: false });

let orientationLockFailed = false;
let orientationQuery: MediaQueryList | undefined;
let pointerQuery: MediaQueryList | undefined;

function orientationLockUsable(): boolean {
  return (
    !orientationLockFailed &&
    typeof screen !== "undefined" &&
    typeof screen.orientation?.lock === "function"
  );
}

function update(): void {
  if (orientationQuery === undefined || pointerQuery === undefined) return;
  pseudoLandscape.active = shouldUsePseudoLandscape({
    portrait: orientationQuery.matches,
    coarsePointer: pointerQuery.matches,
    orientationLockAvailable: orientationLockUsable(),
  });
  // bits-ui 补丁（patches/bits-ui@*.patch）通过该标记类把滑块与 Portal 浮层
  // （如下拉框）的坐标轴换算对齐到伪横屏画面。
  document.documentElement.classList.toggle("pseudo-landscape", pseudoLandscape.active);
}

/** 系统横屏锁定被拒绝时降级为伪横屏（由全屏模块在全屏成功后回报）。 */
export function noteOrientationLockFailed(): void {
  orientationLockFailed = true;
  update();
}

/** 尝试系统横屏锁定；不支持时静默交给伪横屏兜底，失败时记录降级。 */
export function lockLandscapeOrientation(): void {
  if (typeof screen === "undefined" || typeof screen.orientation?.lock !== "function") return;
  void screen.orientation.lock("landscape").catch(() => noteOrientationLockFailed());
}

/** 监听视口方向与指针类型变化并刷新激活状态，返回清理函数。 */
export function installPseudoLandscape(): () => void {
  orientationQuery = window.matchMedia("(orientation: portrait)");
  pointerQuery = window.matchMedia("(pointer: coarse)");
  orientationQuery.addEventListener("change", update);
  pointerQuery.addEventListener("change", update);
  update();
  return () => {
    orientationQuery?.removeEventListener("change", update);
    pointerQuery?.removeEventListener("change", update);
    orientationQuery = undefined;
    pointerQuery = undefined;
    pseudoLandscape.active = false;
    document.documentElement.classList.remove("pseudo-landscape");
  };
}
