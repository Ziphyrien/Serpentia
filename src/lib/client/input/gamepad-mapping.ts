export const GAMEPAD_STICK_ENGAGE_DEAD_ZONE = 0.22;
export const GAMEPAD_STICK_RELEASE_DEAD_ZONE = 0.16;

const BOOST_BUTTON_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7] as const;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;
const BUTTON_THRESHOLD = 0.5;

export interface GamepadButtonState {
  readonly pressed: boolean;
  readonly value: number;
}

export interface GamepadState {
  readonly axes: ReadonlyArray<number>;
  readonly buttons: ReadonlyArray<GamepadButtonState>;
}

export interface GamepadDirection {
  readonly angle: number | undefined;
  readonly stickActive: boolean;
}

export interface GamepadIntent extends GamepadDirection {
  readonly boosting: boolean;
}

export function gamepadIntent(gamepad: GamepadState, stickWasActive: boolean): GamepadIntent {
  const direction = gamepadDirection(gamepad, stickWasActive);
  return {
    ...direction,
    boosting: BOOST_BUTTON_INDEXES.some((index) => buttonActive(gamepad, index)),
  };
}

export function gamepadDirection(gamepad: GamepadState, stickWasActive: boolean): GamepadDirection {
  const dpadX =
    Number(buttonActive(gamepad, DPAD_RIGHT)) - Number(buttonActive(gamepad, DPAD_LEFT));
  const dpadY = Number(buttonActive(gamepad, DPAD_DOWN)) - Number(buttonActive(gamepad, DPAD_UP));
  if (dpadX !== 0 || dpadY !== 0) {
    return { angle: Math.atan2(dpadY, dpadX), stickActive: false };
  }

  const x = finiteAxis(gamepad.axes[0]);
  const y = finiteAxis(gamepad.axes[1]);
  const magnitude = Math.hypot(x, y);
  const deadZone = stickWasActive
    ? GAMEPAD_STICK_RELEASE_DEAD_ZONE
    : GAMEPAD_STICK_ENGAGE_DEAD_ZONE;
  if (magnitude <= deadZone) return { angle: undefined, stickActive: false };
  return { angle: Math.atan2(y, x), stickActive: true };
}

export function hasGamepadActivity(gamepad: GamepadState): boolean {
  const x = finiteAxis(gamepad.axes[0]);
  const y = finiteAxis(gamepad.axes[1]);
  return (
    Math.hypot(x, y) > GAMEPAD_STICK_ENGAGE_DEAD_ZONE ||
    gamepad.buttons.some((button) => button.pressed || button.value >= BUTTON_THRESHOLD)
  );
}

function finiteAxis(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function buttonActive(gamepad: GamepadState, index: number): boolean {
  const button = gamepad.buttons[index];
  return button !== undefined && (button.pressed || button.value >= BUTTON_THRESHOLD);
}
