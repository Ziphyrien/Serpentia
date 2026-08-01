import { Schema } from "effect";

const STORAGE_KEY = "serpentia.settings.v1";
const Volume = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

const PersistedSettingsData = Schema.Struct({
  sfxVolume: Volume,
  musicVolume: Schema.optionalKey(Volume),
  showNicknames: Schema.Boolean,
});
type PersistedSettingsData = typeof PersistedSettingsData.Type;

const decodeSettings = Schema.decodeUnknownSync(PersistedSettingsData);

const DEFAULTS = {
  sfxVolume: 0.3,
  musicVolume: 0.55,
  showNicknames: true,
};

/** Local settings with validated persistence and an explicit change boundary. */
export class SettingsStore {
  sfxVolume = $state(DEFAULTS.sfxVolume);
  musicVolume = $state(DEFAULTS.musicVolume);
  showNicknames = $state(DEFAULTS.showNicknames);

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.assign(decodeSettings(JSON.parse(raw)));
    } catch {
      // Corrupt storage and privacy-mode failures both fall back to defaults.
    }
  }

  setSfxVolume(volume: number): void {
    const clamped = clampVolume(volume);
    if (clamped === undefined || Object.is(this.sfxVolume, clamped)) return;
    this.sfxVolume = clamped;
    this.commit();
  }

  setMusicVolume(volume: number): void {
    const clamped = clampVolume(volume);
    if (clamped === undefined || Object.is(this.musicVolume, clamped)) return;
    this.musicVolume = clamped;
    this.commit();
  }

  setShowNicknames(show: boolean): void {
    if (this.showNicknames === show) return;
    this.showNicknames = show;
    this.commit();
  }

  private assign(settings: PersistedSettingsData): void {
    this.sfxVolume = settings.sfxVolume;
    this.musicVolume = settings.musicVolume ?? DEFAULTS.musicVolume;
    this.showNicknames = settings.showNicknames;
  }

  private commit(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sfxVolume: this.sfxVolume,
          musicVolume: this.musicVolume,
          showNicknames: this.showNicknames,
        }),
      );
    } catch {
      // Runtime settings still apply when persistence is unavailable.
    }
  }
}

function clampVolume(volume: number): number | undefined {
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : undefined;
}
