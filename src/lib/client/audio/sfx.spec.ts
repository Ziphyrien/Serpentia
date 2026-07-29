import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const audioMock = vi.hoisted((): { volumes: Array<number>; playCount: number } => ({
  volumes: [],
  playCount: 0,
}));

vi.mock("howler", () => ({
  Howl: class {
    constructor(options: { readonly volume: number }) {
      audioMock.volumes.push(options.volume);
    }

    play(): number {
      audioMock.playCount += 1;
      return audioMock.playCount;
    }

    unload(): void {}
  },
  Howler: {
    ctx: undefined,
    volume: vi.fn(),
    mute: vi.fn(),
  },
}));

import { Sfx } from "./sfx";

describe("official sound-effect gain", () => {
  beforeEach(() => {
    audioMock.volumes.length = 0;
    audioMock.playCount = 0;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  it("plays every original clip at unity gain", () => {
    const sfx = new Sfx();
    expect(audioMock.volumes).toEqual([1, 1, 1, 1, 1]);
    sfx.dispose();
  });

  it("shares the original 100ms throttle for star and death-remains audio", () => {
    const now = vi.spyOn(Date, "now");
    const sfx = new Sfx();
    now.mockReturnValue(1_000);
    sfx.eatRemains();
    now.mockReturnValue(1_099);
    sfx.eatRemains();
    now.mockReturnValue(1_100);
    sfx.eatRemains();

    expect(audioMock.playCount).toBe(2);
    now.mockRestore();
    sfx.dispose();
  });

  it("throttles original tool pickup audio independently", () => {
    const now = vi.spyOn(Date, "now");
    const sfx = new Sfx();
    now.mockReturnValue(2_000);
    sfx.eatTool();
    now.mockReturnValue(2_099);
    sfx.eatTool();
    now.mockReturnValue(2_100);
    sfx.eatTool();
    expect(audioMock.playCount).toBe(2);
    now.mockRestore();
    sfx.dispose();
  });
});
