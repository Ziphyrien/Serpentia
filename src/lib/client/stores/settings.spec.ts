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
    settings.setSfxMuted(true);
    settings.setShowNicknames(false);
    settings.setHighQuality(false);

    const restored = new SettingsStore();
    expect(restored.sfxVolume).toBe(0.35);
    expect(restored.sfxMuted).toBe(true);
    expect(restored.showNicknames).toBe(false);
    expect(restored.highQuality).toBe(false);
  });

  it("rejects malformed persisted data instead of trusting a type assertion", () => {
    localStorage.setItem(
      "serpentia.settings.v1",
      JSON.stringify({
        sfxVolume: 4,
        sfxMuted: "yes",
        showNicknames: false,
        highQuality: false,
      }),
    );

    const settings = new SettingsStore();
    expect(settings.sfxVolume).toBe(0.8);
    expect(settings.sfxMuted).toBe(false);
    expect(settings.showNicknames).toBe(true);
    expect(settings.highQuality).toBe(true);
  });

  it("notifies subscribers once per effective update", () => {
    const settings = new SettingsStore();
    let notifications = 0;
    const unsubscribe = settings.subscribe(() => {
      notifications += 1;
    });

    settings.setHighQuality(false);
    settings.setHighQuality(false);
    unsubscribe();
    settings.setHighQuality(true);

    expect(notifications).toBe(1);
  });
});
