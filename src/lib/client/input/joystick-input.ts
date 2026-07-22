import nipplejs from "nipplejs";
import type { InputState } from "./input-state";

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
    // nipplejs 未导出事件类型，这里只依赖 vector 字段做最小结构约定
    const emitter = this.manager as unknown as {
      on(event: "move", handler: (data: { vector?: { x: number; y: number } }) => void): void;
    };
    emitter.on("move", (data) => {
      if (!data.vector) return;
      // nipplejs 的 y 轴向上为正，世界坐标 y 向下为正，需要翻转
      this.state.angle = Math.atan2(-data.vector.y, data.vector.x);
      this.state.hasDirection = true;
    });
  }

  detach(): void {
    this.manager?.destroy();
    this.manager = undefined;
  }
}
