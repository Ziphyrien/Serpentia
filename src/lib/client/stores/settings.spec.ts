import { beforeEach, describe, expect, it } from "vite-plus/test";
import { SettingsStore } from "./settings.svelte";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("settings store", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it("persists updates made through the explicit setting methods", () => {
    const settings = new SettingsStore();
    settings.setSfxVolume(0.35);
    settings.setMusicVolume(0.25);
    settings.setShowNicknames(false);

    const restored = new SettingsStore();
    expect(restored.sfxVolume).toBe(0.35);
    expect(restored.musicVolume).toBe(0.25);
    expect(restored.showNicknames).toBe(false);
  });

  it("rejects malformed persisted data instead of trusting a type assertion", () => {
    localStorage.setItem(
      "serpentia.settings.v1",
      JSON.stringify({
        sfxVolume: 4,
        musicVolume: "loud",
        showNicknames: false,
      }),
    );

    const settings = new SettingsStore();
    expect(settings.sfxVolume).toBe(0.3);
    expect(settings.musicVolume).toBe(0.55);
    expect(settings.showNicknames).toBe(true);
  });
});
