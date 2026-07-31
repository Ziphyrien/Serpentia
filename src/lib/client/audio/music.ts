import { Howl, Howler } from "howler";
import type { MusicPlaybackState } from "$lib/protocol";

const MAX_DRIFT_SECONDS = 0.35;

export class MusicPlayback {
  private stateValue: MusicPlaybackState | undefined;
  private sound: Howl | undefined;
  private url: string | undefined;
  private volume = 1;
  private readonly correctionTimer: ReturnType<typeof setInterval>;
  private readonly unlock = (): void => {
    void Howler.ctx?.resume?.();
    this.synchronize();
  };

  constructor(private readonly serverNow: () => number) {
    this.correctionTimer = setInterval(() => this.synchronize(), 1_000);
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
  }

  get state(): MusicPlaybackState | undefined {
    return this.stateValue;
  }

  apply(state: MusicPlaybackState, force = false): void {
    if (!force && this.stateValue !== undefined && state.revision < this.stateValue.revision)
      return;
    this.stateValue = state;
    if (state._tag === "stopped" || state._tag === "loading") {
      this.releaseSound();
      return;
    }
    if (this.url !== state.track.url || this.sound === undefined) {
      this.releaseSound();
      this.url = state.track.url;
      const revision = state.revision;
      this.sound = new Howl({
        src: [state.track.url],
        html5: true,
        preload: true,
        volume: this.volume,
        onload: () => {
          if (this.stateValue?.revision === revision) this.synchronize();
        },
        onplayerror: () => {
          if (this.stateValue?.revision === revision) void Howler.ctx?.resume?.();
        },
      });
    }
    this.synchronize();
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.min(1, Math.max(0, volume));
    this.sound?.volume(this.volume);
  }

  positionSeconds(): number {
    const state = this.stateValue;
    if (state?._tag === "paused") return state.positionSeconds;
    if (state?._tag !== "playing") return 0;
    return expectedPosition(state, this.serverNow());
  }

  dispose(): void {
    clearInterval(this.correctionTimer);
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
    this.releaseSound();
    this.stateValue = undefined;
  }

  private synchronize(): void {
    const state = this.stateValue;
    const sound = this.sound;
    if (state === undefined || sound === undefined || sound.state() !== "loaded") return;
    if (state._tag === "paused") {
      if (sound.playing()) sound.pause();
      seekTo(sound, state.positionSeconds);
      return;
    }
    if (state._tag !== "playing") return;
    const expected = expectedPosition(state, this.serverNow());
    const duration = sound.duration();
    if (duration > 0 && expected >= duration) {
      sound.stop();
      return;
    }
    const actual = sound.seek();
    if (typeof actual !== "number" || Math.abs(actual - expected) > MAX_DRIFT_SECONDS) {
      seekTo(sound, expected);
    }
    if (!sound.playing()) sound.play();
  }

  private releaseSound(): void {
    this.sound?.unload();
    this.sound = undefined;
    this.url = undefined;
  }
}

export function expectedPosition(
  state: Extract<MusicPlaybackState, { _tag: "playing" }>,
  serverNow: number,
): number {
  return Math.min(
    86_400,
    Math.max(0, state.positionSeconds + (serverNow - state.anchorServerTime) / 1_000),
  );
}

function seekTo(sound: Howl, positionSeconds: number): void {
  sound.seek(Math.max(0, positionSeconds));
}
