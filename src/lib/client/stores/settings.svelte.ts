const STORAGE_KEY = "serpentia.settings.v1";

interface SettingsData {
  sfxVolume: number;
  sfxMuted: boolean;
  showNicknames: boolean;
  highQuality: boolean;
}

const DEFAULTS: SettingsData = {
  sfxVolume: 0.8,
  sfxMuted: false,
  showNicknames: true,
  highQuality: true,
};

/** 本地设置：localStorage 持久化，响应式供 UI 与音效/渲染读取。 */
export class SettingsStore {
  sfxVolume = $state(DEFAULTS.sfxVolume);
  sfxMuted = $state(DEFAULTS.sfxMuted);
  showNicknames = $state(DEFAULTS.showNicknames);
  highQuality = $state(DEFAULTS.highQuality);

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<SettingsData>) };
        this.sfxVolume = parsed.sfxVolume;
        this.sfxMuted = parsed.sfxMuted;
        this.showNicknames = parsed.showNicknames;
        this.highQuality = parsed.highQuality;
      }
    } catch {
      // 隐私模式等场景下静默使用默认值
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sfxVolume: this.sfxVolume,
          sfxMuted: this.sfxMuted,
          showNicknames: this.showNicknames,
          highQuality: this.highQuality,
        } satisfies SettingsData),
      );
    } catch {
      // 忽略持久化失败
    }
  }

  setSfxVolume(volume: number): void {
    this.sfxVolume = volume;
    this.persist();
  }

  setSfxMuted(muted: boolean): void {
    this.sfxMuted = muted;
    this.persist();
  }

  setShowNicknames(show: boolean): void {
    this.showNicknames = show;
    this.persist();
  }

  setHighQuality(high: boolean): void {
    this.highQuality = high;
    this.persist();
  }
}
