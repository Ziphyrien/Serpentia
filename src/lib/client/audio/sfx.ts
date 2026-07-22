import { Howl, Howler } from "howler";

export type SfxName = "eat" | "eat-big" | "boost" | "death" | "kill" | "respawn" | "click" | "warn";

/**
 * 音效管理（howler 封装）：负责加载、音量、静音与连击变调。
 * 不知道游戏逻辑，只暴露语义化播放接口。
 */
export class Sfx {
  private readonly sounds: Record<SfxName, Howl>;
  private boostSoundId: number | undefined;
  private eatChainAt = 0;
  private eatChainCount = 0;
  private unlocked = false;

  constructor() {
    const make = (name: SfxName, options: { loop?: boolean; volume?: number } = {}) =>
      new Howl({
        src: [`/assets/sfx/${name}.wav`],
        format: ["wav"],
        loop: options.loop ?? false,
        volume: options.volume ?? 1,
        preload: true,
      });
    this.sounds = {
      eat: make("eat", { volume: 0.5 }),
      "eat-big": make("eat-big", { volume: 0.55 }),
      boost: make("boost", { loop: true, volume: 0.35 }),
      death: make("death", { volume: 0.7 }),
      kill: make("kill", { volume: 0.6 }),
      respawn: make("respawn", { volume: 0.6 }),
      click: make("click", { volume: 0.5 }),
      warn: make("warn", { volume: 0.4 }),
    };

    const unlock = (): void => {
      if (this.unlocked) return;
      this.unlocked = true;
      void Howler.ctx?.resume?.();
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  }

  setVolume(volume: number): void {
    Howler.volume(volume);
  }

  setMuted(muted: boolean): void {
    Howler.mute(muted);
  }

  /** 吃食物：短时间内连续吃会升调形成连击感。 */
  eat(big = false): void {
    const now = performance.now();
    if (now - this.eatChainAt > 800) this.eatChainCount = 0;
    this.eatChainAt = now;
    this.eatChainCount = Math.min(this.eatChainCount + 1, 8);
    const name: SfxName = big ? "eat-big" : "eat";
    const id = this.sounds[name].play();
    this.sounds[name].rate(1 + this.eatChainCount * 0.06, id);
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

  warn(): void {
    this.sounds.warn.play();
  }

  /** 加速风声随 boosting 状态启停。 */
  setBoosting(active: boolean): void {
    const sound = this.sounds.boost;
    if (active && this.boostSoundId === undefined) {
      this.boostSoundId = sound.play();
      sound.fade(0, 0.35, 150, this.boostSoundId);
    } else if (!active && this.boostSoundId !== undefined) {
      sound.fade(0.35, 0, 200, this.boostSoundId);
      const fading = this.boostSoundId;
      window.setTimeout(() => sound.stop(fading), 220);
      this.boostSoundId = undefined;
    }
  }

  dispose(): void {
    for (const sound of Object.values(this.sounds)) sound.unload();
  }
}
