import {
  MusicControllerInfo,
  MusicLoadingState,
  MusicPausedState,
  MusicPlayingState,
  MusicResolvedTrack,
  MusicSourceResolveRequest,
  MusicStoppedState,
  MusicTrackSummary,
  type MusicControl,
  type MusicPlaybackState,
  type MusicSourceErrorCode,
  type MusicSourceResolveResponse,
} from "../../protocol";
import { isMusicSourceError } from "./errors";

export interface MusicResolver {
  resolve(
    request: MusicSourceResolveRequest,
    signal?: AbortSignal,
  ): Promise<MusicSourceResolveResponse>;
}

export interface MusicCoordinatorEvents {
  stateChanged(state: MusicPlaybackState): void;
  commandFailed(playerId: string, code: MusicSourceErrorCode): void;
}

export interface MusicCommandActor {
  readonly playerId: string;
  readonly nickname: string;
}

export class MusicCoordinator {
  private revision = 0;
  private stateValue: MusicPlaybackState;
  private pending: AbortController | undefined;
  private disposed = false;

  constructor(
    private readonly resolver: MusicResolver,
    private readonly events: MusicCoordinatorEvents,
    private readonly now: () => number = Date.now,
  ) {
    this.stateValue = MusicStoppedState.make({
      revision: 0,
      changedAt: this.now(),
      changedBy: null,
    });
  }

  get state(): MusicPlaybackState {
    return this.stateValue;
  }

  control(actorInput: MusicCommandActor, command: MusicControl): void {
    if (this.disposed) return;
    const actor = MusicControllerInfo.make(actorInput);
    const revision = ++this.revision;
    this.pending?.abort();
    this.pending = undefined;

    switch (command._tag) {
      case "play":
        this.play(revision, actor, command);
        return;
      case "pause":
        this.pause(revision, actor);
        return;
      case "resume":
        this.resume(revision, actor);
        return;
      case "seek":
        this.seek(revision, actor, command.positionSeconds);
        return;
      case "stop":
        this.stop(revision, actor);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.revision += 1;
    this.pending?.abort();
    this.pending = undefined;
  }

  private play(
    revision: number,
    actor: MusicControllerInfo,
    command: Extract<MusicControl, { _tag: "play" }>,
  ): void {
    const changedAt = this.now();
    this.publish(
      MusicLoadingState.make({
        revision,
        changedAt,
        changedBy: actor,
        track: MusicTrackSummary.make({
          source: command.source,
          title: command.title,
          artist: command.artist,
        }),
      }),
    );
    const controller = new AbortController();
    this.pending = controller;
    const request = MusicSourceResolveRequest.make({
      source: command.source,
      action: "musicUrl",
      info: command.info,
    });
    void this.resolver.resolve(request, controller.signal).then(
      (result) => {
        if (!this.isCurrent(revision, controller) || result.action !== "musicUrl") return;
        this.pending = undefined;
        const anchorServerTime = this.now();
        const type = result.data.type;
        this.publish(
          MusicPlayingState.make({
            revision,
            changedAt: anchorServerTime,
            changedBy: actor,
            track: MusicResolvedTrack.make({
              source: command.source,
              title: command.title,
              artist: command.artist,
              ...(type === undefined ? {} : { type }),
              url: result.data.url,
            }),
            positionSeconds: 0,
            anchorServerTime,
          }),
        );
      },
      (cause) => {
        if (!this.isCurrent(revision, controller)) return;
        this.pending = undefined;
        this.publish(MusicStoppedState.make({ revision, changedAt: this.now(), changedBy: actor }));
        this.events.commandFailed(
          actor.playerId,
          isMusicSourceError(cause) ? cause.code : "RUNTIME_UNAVAILABLE",
        );
      },
    );
  }

  private pause(revision: number, actor: MusicControllerInfo): void {
    if (this.stateValue._tag === "playing") {
      this.publish(
        MusicPausedState.make({
          revision,
          changedAt: this.now(),
          changedBy: actor,
          track: this.stateValue.track,
          positionSeconds: this.playingPosition(this.stateValue),
        }),
      );
      return;
    }
    if (this.stateValue._tag === "paused") {
      this.publish(
        MusicPausedState.make({
          revision,
          changedAt: this.now(),
          changedBy: actor,
          track: this.stateValue.track,
          positionSeconds: this.stateValue.positionSeconds,
        }),
      );
      return;
    }
    this.stop(revision, actor);
  }

  private resume(revision: number, actor: MusicControllerInfo): void {
    if (this.stateValue._tag === "paused") {
      const anchorServerTime = this.now();
      this.publish(
        MusicPlayingState.make({
          revision,
          changedAt: anchorServerTime,
          changedBy: actor,
          track: this.stateValue.track,
          positionSeconds: this.stateValue.positionSeconds,
          anchorServerTime,
        }),
      );
      return;
    }
    if (this.stateValue._tag === "playing") {
      const positionSeconds = this.playingPosition(this.stateValue);
      const anchorServerTime = this.now();
      this.publish(
        MusicPlayingState.make({
          revision,
          changedAt: anchorServerTime,
          changedBy: actor,
          track: this.stateValue.track,
          positionSeconds,
          anchorServerTime,
        }),
      );
      return;
    }
    this.stop(revision, actor);
  }

  private seek(revision: number, actor: MusicControllerInfo, positionSeconds: number): void {
    if (this.stateValue._tag === "playing") {
      const anchorServerTime = this.now();
      this.publish(
        MusicPlayingState.make({
          revision,
          changedAt: anchorServerTime,
          changedBy: actor,
          track: this.stateValue.track,
          positionSeconds,
          anchorServerTime,
        }),
      );
      return;
    }
    if (this.stateValue._tag === "paused") {
      this.publish(
        MusicPausedState.make({
          revision,
          changedAt: this.now(),
          changedBy: actor,
          track: this.stateValue.track,
          positionSeconds,
        }),
      );
      return;
    }
    this.stop(revision, actor);
  }

  private stop(revision: number, actor: MusicControllerInfo): void {
    this.publish(MusicStoppedState.make({ revision, changedAt: this.now(), changedBy: actor }));
  }

  private playingPosition(state: Extract<MusicPlaybackState, { _tag: "playing" }>): number {
    return Math.min(
      86_400,
      Math.max(0, state.positionSeconds + (this.now() - state.anchorServerTime) / 1_000),
    );
  }

  private isCurrent(revision: number, controller: AbortController): boolean {
    return !this.disposed && this.revision === revision && this.pending === controller;
  }

  private publish(state: MusicPlaybackState): void {
    this.stateValue = state;
    this.events.stateChanged(state);
  }
}
