import { Howl, Howler } from "howler";

type SfxName = "eat-wreck" | "end" | "kill" | "button-click";

/**
 * 音效管理（howler 封装）：负责加载、音量与静音。
 * 不知道游戏逻辑，只暴露语义化播放接口。
 */
export class Sfx {
  private readonly sounds: Record<SfxName, Howl>;
  private unlocked = false;
  private lastEatWreckAt = Number.NEGATIVE_INFINITY;
  private readonly unlock = (): void => {
    if (this.unlocked) return;
    this.unlocked = true;
    this.removeUnlockListeners();
    void Howler.ctx?.resume?.();
  };

  constructor() {
    const createSound = (name: SfxName) =>
      new Howl({
        src: [`/assets/audio/sfx/${name}.mp3`],
        format: ["mp3"],
        volume: 1,
        preload: true,
      });
    this.sounds = {
      "eat-wreck": createSound("eat-wreck"),
      end: createSound("end"),
      kill: createSound("kill"),
      "button-click": createSound("button-click"),
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

  /** 原版 `playEatWreckAudio`：星星和死亡残骸共用 100 ms 节流。 */
  eatRemains(): void {
    const now = Date.now();
    if (now < this.lastEatWreckAt + 100) return;
    this.lastEatWreckAt = now;
    this.sounds["eat-wreck"].play();
  }

  death(): void {
    this.sounds.end.play();
  }

  kill(): void {
    this.sounds.kill.play();
  }

  click(): void {
    this.sounds["button-click"].play();
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
