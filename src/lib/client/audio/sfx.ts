import { Howl, Howler } from "howler";

type SfxName = "eat-remains" | "death" | "kill" | "respawn" | "click";

/**
 * 音效管理（howler 封装）：负责加载、音量与静音。
 * 不知道游戏逻辑，只暴露语义化播放接口。
 */
export class Sfx {
  private readonly sounds: Record<SfxName, Howl>;
  private unlocked = false;
  private readonly unlock = (): void => {
    if (this.unlocked) return;
    this.unlocked = true;
    this.removeUnlockListeners();
    void Howler.ctx?.resume?.();
  };

  constructor() {
    const createSound = (name: SfxName, volume: number) =>
      new Howl({
        src: [`/assets/sfx/${name}.wav`],
        format: ["wav"],
        volume,
        preload: true,
      });
    this.sounds = {
      "eat-remains": createSound("eat-remains", 0.55),
      death: createSound("death", 0.7),
      kill: createSound("kill", 0.6),
      respawn: createSound("respawn", 0.6),
      click: createSound("click", 0.5),
    };

    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
  }

  setVolume(volume: number): void {
    Howler.volume(volume);
  }

  setMuted(muted: boolean): void {
    Howler.mute(muted);
  }

  /**
   * 吃到尸体食物。普通食物不发声，避免持续进食时音效连成一片。
   *
   * 以固定音高播放：尸体是成片散落的，重叠触发只会变响而不会走音，
   * 因此不需要连击变调。
   */
  eatRemains(): void {
    this.sounds["eat-remains"].play();
  }

  death(): void {
    this.sounds.death.play();
  }

  kill(): void {
    this.sounds.kill.play();
  }

  respawn(): void {
    this.sounds.respawn.play();
  }

  click(): void {
    this.sounds.click.play();
  }

  dispose(): void {
    this.removeUnlockListeners();
    for (const sound of Object.values(this.sounds)) sound.unload();
  }

  private removeUnlockListeners(): void {
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
  }
}
