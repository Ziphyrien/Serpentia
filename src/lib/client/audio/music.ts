import type { MusicPlaybackState } from "$lib/protocol";

const STATE_SEEK_THRESHOLD_SECONDS = 0.35;
const HAVE_METADATA = 1;

export type MusicPlaybackFailure = "load" | "play";

export class MusicPlayback {
  private stateValue: MusicPlaybackState | undefined;
  private audio: HTMLAudioElement | undefined;
  private url: string | undefined;
  private volume = 1;
  private removeAudioListeners: (() => void) | undefined;
  private playPending: Promise<void> | undefined;
  private readonly unlock = (): void => this.resumeIfPlaying();

  constructor(
    private readonly serverNow: () => number,
    private readonly onFailure: (failure: MusicPlaybackFailure) => void = () => undefined,
  ) {
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
  }

  get state(): MusicPlaybackState | undefined {
    return this.stateValue;
  }

  apply(state: MusicPlaybackState, force = false): void {
    if (!force && this.stateValue !== undefined && state.revision < this.stateValue.revision) {
      return;
    }
    const previousRevision = this.stateValue?.revision;
    this.stateValue = state;
    if (state._tag === "stopped" || state._tag === "loading") {
      this.releaseAudio();
      return;
    }

    const sourceChanged = this.url !== state.track.url || this.audio === undefined;
    if (sourceChanged) this.createAudio(state.track.url);
    this.synchronize(force || sourceChanged || previousRevision !== state.revision);
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.audio !== undefined) this.audio.volume = this.volume;
  }

  positionSeconds(): number {
    const state = this.stateValue;
    if (state?._tag === "paused") return state.positionSeconds;
    if (state?._tag !== "playing") return 0;
    return expectedPosition(state, this.serverNow());
  }

  dispose(): void {
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
    this.releaseAudio();
    this.stateValue = undefined;
  }

  private createAudio(url: string): void {
    this.releaseAudio();
    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = this.volume;

    const loadedMetadata = (): void => {
      if (this.audio === audio) this.synchronize(true);
    };
    const canPlay = (): void => {
      if (this.audio === audio) this.resumeIfPlaying();
    };
    const failed = (): void => {
      if (this.audio === audio) this.onFailure("load");
    };
    audio.addEventListener("loadedmetadata", loadedMetadata);
    audio.addEventListener("canplay", canPlay);
    audio.addEventListener("error", failed);

    this.audio = audio;
    this.url = url;
    this.removeAudioListeners = () => {
      audio.removeEventListener("loadedmetadata", loadedMetadata);
      audio.removeEventListener("canplay", canPlay);
      audio.removeEventListener("error", failed);
    };
    audio.src = url;
    audio.load();
  }

  private synchronize(seekToState: boolean): void {
    const state = this.stateValue;
    const audio = this.audio;
    if (state === undefined || audio === undefined) return;
    if (state._tag === "paused") {
      if (!audio.paused) audio.pause();
      if (seekToState) this.seek(audio, state.positionSeconds);
      return;
    }
    if (state._tag !== "playing") return;
    if (seekToState) this.seek(audio, expectedPosition(state, this.serverNow()));
    this.resumeIfPlaying();
  }

  private seek(audio: HTMLAudioElement, positionSeconds: number): void {
    if (audio.readyState < HAVE_METADATA) return;
    const requested = Math.max(0, positionSeconds);
    const target =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? Math.min(requested, audio.duration)
        : requested;
    if (Math.abs(audio.currentTime - target) > STATE_SEEK_THRESHOLD_SECONDS) {
      audio.currentTime = target;
    }
  }

  private resumeIfPlaying(): void {
    const state = this.stateValue;
    const audio = this.audio;
    if (
      state?._tag !== "playing" ||
      audio === undefined ||
      audio.readyState < HAVE_METADATA ||
      !audio.paused ||
      this.playPending !== undefined
    ) {
      return;
    }
    const attempt = audio.play();
    this.playPending = attempt;
    void attempt.then(
      () => {
        if (this.audio === audio && this.playPending === attempt) this.playPending = undefined;
      },
      (cause: unknown) => {
        if (this.audio !== audio || this.playPending !== attempt) return;
        this.playPending = undefined;
        if (this.stateValue?._tag === "playing" && !isAbortError(cause)) {
          this.onFailure("play");
        }
      },
    );
  }

  private releaseAudio(): void {
    const audio = this.audio;
    this.audio = undefined;
    this.url = undefined;
    this.playPending = undefined;
    this.removeAudioListeners?.();
    this.removeAudioListeners = undefined;
    if (audio === undefined) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
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

function isAbortError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    cause.name === "AbortError"
  );
}
