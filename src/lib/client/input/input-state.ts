export type InputStateListener = () => void;

/**
 * Shared input intent for pointer, keyboard, and joystick controls.
 * Consumers can subscribe to changes so the first input is sent immediately;
 * network throttling remains the controller's responsibility.
 */
export class InputState {
  private currentAngle = 0;
  private currentBoosting = false;
  private directionAvailable = false;
  private readonly listeners = new Set<InputStateListener>();

  get angle(): number {
    return this.currentAngle;
  }

  set angle(value: number) {
    if (Object.is(this.currentAngle, value)) return;
    this.currentAngle = value;
    this.notify();
  }

  get boosting(): boolean {
    return this.currentBoosting;
  }

  set boosting(value: boolean) {
    if (this.currentBoosting === value) return;
    this.currentBoosting = value;
    this.notify();
  }

  /** Whether any device has supplied a direction yet. */
  get hasDirection(): boolean {
    return this.directionAvailable;
  }

  set hasDirection(value: boolean) {
    if (this.directionAvailable === value) return;
    this.directionAvailable = value;
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
