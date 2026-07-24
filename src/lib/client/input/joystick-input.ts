import nipplejs from "nipplejs";
import type { InputState } from "./input-state";
import { directionAngleFromJoystickVector } from "./joystick-vector";

/**
 * 移动端虚拟摇杆（nipplejs 封装）。
 * 只把摇杆向量翻译成 InputState，生命周期由 TouchControls 组件托管。
 */
type JoystickCollection = ReturnType<typeof nipplejs.create>;

export class JoystickInput {
  private manager: JoystickCollection | undefined;

  constructor(private readonly state: InputState) {}

  attach(zone: HTMLElement): void {
    this.manager = nipplejs.create({
      zone,
      mode: "dynamic",
      position: { left: "50%", top: "50%" },
      size: 128,
      color: "white",
      fadeTime: 120,
    });
    // nipplejs 的 move 回调签名是 (event)，摇杆数据在 event.data 上
    this.manager.on("move", (event) => {
      const angle = directionAngleFromJoystickVector(event.data.vector);
      if (angle === undefined) return;
      this.state.angle = angle;
      this.state.hasDirection = true;
    });
  }

  detach(): void {
    this.manager?.destroy();
    this.manager = undefined;
  }
}
