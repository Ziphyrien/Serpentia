import type { InputState } from "./input-state";
import { gamepadIntent, hasGamepadActivity } from "./gamepad-mapping";

export interface ActiveGamepad {
  readonly index: number;
  readonly id: string;
}

export interface HapticGamepad {
  readonly vibrationActuator?: Pick<GamepadHapticActuator, "playEffect">;
}

const DEATH_RUMBLE_PARAMETERS: GamepadEffectParameters = {
  duration: 420,
  startDelay: 0,
  strongMagnitude: 1,
  weakMagnitude: 0.55,
};

export class GamepadInput {
  private animationFrame = 0;
  private activeIndex: number | undefined;
  private stickActive = false;
  private disposed = false;
  private reportedGamepad: ActiveGamepad | undefined;

  constructor(
    private readonly state: InputState,
    private readonly onActiveGamepadChanged: (gamepad: ActiveGamepad | undefined) => void,
  ) {
    if (!supportsGamepads()) return;
    window.addEventListener("gamepadconnected", this.onGamepadConnected);
    window.addEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    window.addEventListener("blur", this.onBlur);
    this.sampleGamepads();
    this.animationFrame = requestAnimationFrame(this.poll);
  }

  rumbleOnDeath(): void {
    const gamepads = connectedGamepads();
    const gamepad =
      gamepads.find((candidate) => candidate.index === this.activeIndex) ?? gamepads[0];
    void playDeathRumble(gamepad);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.animationFrame !== 0) cancelAnimationFrame(this.animationFrame);
    window.removeEventListener("gamepadconnected", this.onGamepadConnected);
    window.removeEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    window.removeEventListener("blur", this.onBlur);
    this.releaseActiveGamepad();
    this.report(undefined);
  }

  private readonly poll = (): void => {
    if (this.disposed) return;
    this.sampleGamepads();
    this.animationFrame = requestAnimationFrame(this.poll);
  };

  private readonly onGamepadConnected = (event: GamepadEvent): void => {
    if (this.activeIndex === undefined) this.activeIndex = event.gamepad.index;
    this.sampleGamepads();
  };

  private readonly onGamepadDisconnected = (event: GamepadEvent): void => {
    if (this.activeIndex === event.gamepad.index) {
      this.releaseActiveGamepad();
      this.activeIndex = undefined;
    }
    this.sampleGamepads();
  };

  private readonly onBlur = (): void => {
    this.releaseActiveGamepad();
  };

  private sampleGamepads(): void {
    const gamepads = connectedGamepads();
    const selected = this.selectGamepad(gamepads);
    if (!selected) {
      this.releaseActiveGamepad();
      this.activeIndex = undefined;
      this.report(undefined);
      return;
    }

    if (selected.index !== this.activeIndex) {
      this.releaseActiveGamepad();
      this.activeIndex = selected.index;
    }

    const intent = gamepadIntent(selected, this.stickActive);
    this.stickActive = intent.stickActive;
    if (intent.angle === undefined) this.state.releaseDirection("gamepad");
    else this.state.setDirection("gamepad", intent.angle);
    this.state.setBoosting("gamepad", intent.boosting);
    this.report({ index: selected.index, id: gamepadName(selected) });
  }

  private selectGamepad(gamepads: ReadonlyArray<Gamepad>): Gamepad | undefined {
    const current = gamepads.find((gamepad) => gamepad.index === this.activeIndex);
    if (current && hasGamepadActivity(current)) return current;
    return gamepads.find(hasGamepadActivity) ?? current ?? gamepads[0];
  }

  private releaseActiveGamepad(): void {
    this.state.releaseDirection("gamepad");
    this.state.setBoosting("gamepad", false);
    this.stickActive = false;
  }

  private report(gamepad: ActiveGamepad | undefined): void {
    if (
      this.reportedGamepad?.index === gamepad?.index &&
      this.reportedGamepad?.id === gamepad?.id
    ) {
      return;
    }
    this.reportedGamepad = gamepad;
    this.onActiveGamepadChanged(gamepad);
  }
}

export async function playDeathRumble(gamepad: HapticGamepad | undefined): Promise<void> {
  try {
    const actuator = gamepad?.vibrationActuator;
    if (actuator === undefined) return;
    await actuator.playEffect("dual-rumble", DEATH_RUMBLE_PARAMETERS);
  } catch {
    // Haptics are optional and may be blocked or disappear during disconnection.
  }
}

function supportsGamepads(): boolean {
  return typeof window !== "undefined" && typeof navigator.getGamepads === "function";
}

function connectedGamepads(): Array<Gamepad> {
  try {
    return Array.from(navigator.getGamepads()).filter(
      (gamepad): gamepad is Gamepad => gamepad !== null && gamepad.connected,
    );
  } catch {
    return [];
  }
}

function gamepadName(gamepad: Gamepad): string {
  const name = gamepad.id.trim();
  return name.length > 0 ? name : `游戏手柄 ${gamepad.index + 1}`;
}
