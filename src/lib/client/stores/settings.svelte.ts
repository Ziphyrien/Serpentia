import { Schema } from "effect";

const STORAGE_KEY = "serpentia.settings.v1";

const SettingsData = Schema.Struct({
  sfxVolume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  sfxMuted: Schema.Boolean,
  showNicknames: Schema.Boolean,
  highQuality: Schema.Boolean,
});
type SettingsData = typeof SettingsData.Type;

const decodeSettings = Schema.decodeUnknownSync(SettingsData);

const DEFAULTS: SettingsData = {
  sfxVolume: 0.8,
  sfxMuted: false,
  showNicknames: true,
  highQuality: true,
};

export type SettingsListener = () => void;

/** Local settings with validated persistence and an explicit change boundary. */
export class SettingsStore {
  sfxVolume = $state(DEFAULTS.sfxVolume);
  sfxMuted = $state(DEFAULTS.sfxMuted);
  showNicknames = $state(DEFAULTS.showNicknames);
  highQuality = $state(DEFAULTS.highQuality);

  private readonly listeners = new Set<SettingsListener>();

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.assign(decodeSettings(JSON.parse(raw)));
    } catch {
      // Corrupt storage and privacy-mode failures both fall back to defaults.
    }
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSfxVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    const clamped = Math.min(1, Math.max(0, volume));
    if (Object.is(this.sfxVolume, clamped)) return;
    this.sfxVolume = clamped;
    this.commit();
  }

  setSfxMuted(muted: boolean): void {
    if (this.sfxMuted === muted) return;
    this.sfxMuted = muted;
    this.commit();
  }

  setShowNicknames(show: boolean): void {
    if (this.showNicknames === show) return;
    this.showNicknames = show;
    this.commit();
  }

  setHighQuality(high: boolean): void {
    if (this.highQuality === high) return;
    this.highQuality = high;
    this.commit();
  }

  private assign(settings: SettingsData): void {
    this.sfxVolume = settings.sfxVolume;
    this.sfxMuted = settings.sfxMuted;
    this.showNicknames = settings.showNicknames;
    this.highQuality = settings.highQuality;
  }

  private commit(): void {
    const settings: SettingsData = {
      sfxVolume: this.sfxVolume,
      sfxMuted: this.sfxMuted,
      showNicknames: this.showNicknames,
      highQuality: this.highQuality,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Runtime settings still apply when persistence is unavailable.
    }
    for (const listener of this.listeners) listener();
  }
}
