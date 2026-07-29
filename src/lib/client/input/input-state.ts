type InputStateListener = () => void;

export type DirectionInputSource = "pointer" | "joystick" | "gamepad";
export type BoostInputSource = "pointer" | "keyboard" | "touch" | "gamepad";

/**
 * 所有本地输入设备的意图聚合点。
 *
 * 方向采用最近活动设备提交的角度；加速按来源做 OR 合并，任一设备保持按下即生效。
 * 对外只暴露只读结果，设备必须显式提交或释放自己的来源状态。
 */
export class InputState {
  private currentAngle = 0;
  private currentBoosting = false;
  private directionAvailable = false;
  private directionSource: DirectionInputSource | undefined;
  private readonly boostingSources = new Set<BoostInputSource>();
  private readonly listeners = new Set<InputStateListener>();

  get angle(): number {
    return this.currentAngle;
  }

  get boosting(): boolean {
    return this.currentBoosting;
  }

  get hasDirection(): boolean {
    return this.directionAvailable;
  }

  get activeDirectionSource(): DirectionInputSource | undefined {
    return this.directionSource;
  }

  setDirection(source: DirectionInputSource, angle: number): void {
    if (!Number.isFinite(angle)) return;
    const angleChanged = !Object.is(this.currentAngle, angle);
    const availabilityChanged = !this.directionAvailable;
    this.directionSource = source;
    if (!angleChanged && !availabilityChanged) return;
    this.currentAngle = angle;
    this.directionAvailable = true;
    this.notify();
  }

  releaseDirection(source: DirectionInputSource): void {
    if (this.directionSource === source) this.directionSource = undefined;
  }

  setBoosting(source: BoostInputSource, active: boolean): void {
    if (active) this.boostingSources.add(source);
    else this.boostingSources.delete(source);
    const boosting = this.boostingSources.size > 0;
    if (this.currentBoosting === boosting) return;
    this.currentBoosting = boosting;
    this.notify();
  }

  subscribe(listener: InputStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
