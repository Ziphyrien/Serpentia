import type {
  BackendDescriptor,
  GameSnapshot,
  ServerMessage,
  MusicControl,
  MusicPlaybackState,
  SessionInfo,
  TickEventBatch,
} from "$lib/protocol";
import type { PlayerId } from "$lib/protocol/state";
import { INPUT } from "./config";
import { ClockSync } from "./net/clock-sync";
import { GameClient } from "./net/game-client";
import { PredictionLeadEstimator } from "./net/prediction-lead";
import { SnapshotBuffer } from "./sim/snapshot-buffer";
import { SelfPredictor } from "./sim/self-predictor";
import { InputState } from "./input/input-state";
import { MenuAutopilot } from "./input/menu-autopilot";
import { PointerInput } from "./input/pointer-input";
import { JoystickInput } from "./input/joystick-input";
import { GamepadInput } from "./input/gamepad-input";
import { nextNetworkInput, type NetworkInputCommand } from "./input/network-input";
import { MusicPlayback } from "./audio/music";
import { Sfx } from "./audio/sfx";
import type { GameConnectionStatus } from "./game-readiness";
import { terminalGameCloseNotice } from "./game-close-notice";
import {
  rankAliveSnakes,
  selectGameMapMarkers,
  visibleHudRanks,
  type GameMapMarker,
  type HudRankEntry,
} from "./hud/game-hud";
import { VoiceManager, type VoicePeerView } from "./voice/voice-manager";
import type { SettingsStore } from "./stores/settings.svelte";

/** 打开共享音乐管理弹窗的窗口事件：设置弹窗经控制器广播，音乐弹窗监听。 */
export const OPEN_MUSIC_MANAGER_EVENT = "serpentia:open-music-manager";

export type GameMenuId = "settings" | "voice" | "music";

export interface KillFeedEntry {
  id: number;
  text: string;
}

export interface HudSelf {
  length: number;
  kills: number;
  score: number;
  alive: boolean;
  /** 剩余重生秒数；活着时为 0 */
  respawnIn: number;
  /** 权威磁铁剩余秒数。 */
  magnetRemaining: number;
  deathBy?: string;
}

/**
 * 游戏控制器（组合根）：装配网络、预测、输入、音效、语音，
 * 把纯 TS 模块的事件汇聚成 Svelte 响应式状态供 UI 消费。
 * 渲染器通过 attachRenderer 挂载，与本类保持单向依赖。
 */
export class GameController {
  readonly input = new InputState();
  readonly sfx = new Sfx();
  readonly music: MusicPlayback;

  status = $state<GameConnectionStatus>("connecting");
  /** 网络、纹理和包含权威快照的首个 Pixi 帧均已完成。 */
  gameReady = $state(false);
  selfId = $state<PlayerId | undefined>(undefined);
  leaderboard = $state<Array<HudRankEntry>>([]);
  gameMapMarkers = $state<Array<GameMapMarker>>([]);
  self = $state<HudSelf>({
    length: 0,
    kills: 0,
    score: 0,
    alive: true,
    respawnIn: 0,
    magnetRemaining: 0,
  });
  killFeed = $state<Array<KillFeedEntry>>([]);
  pingMs = $state(0);
  voicePeers = $state<Array<VoicePeerView>>([]);
  voiceJoined = $state(false);
  musicState = $state<MusicPlaybackState | undefined>(undefined);
  musicError = $state<string | undefined>(undefined);
  /** 本地麦克风实时电平（0-1），供 HUD 麦克风按钮显示。 */
  voiceLevel = $state(0);
  voiceError = $state<string | undefined>(undefined);
  notice = $state<string | undefined>(undefined);
  gamepadConnected = $state(false);
  gamepadName = $state<string | undefined>(undefined);

  /** 渲染层直读的最新快照（非响应式，避免 10Hz 大对象进入依赖图）。 */
  latestSnapshot: GameSnapshot | undefined;

  private readonly clock = new ClockSync();
  private readonly predictionLead = new PredictionLeadEstimator();
  private readonly buffer = new SnapshotBuffer(() => this.selfId);
  private readonly predictor: SelfPredictor;
  private readonly pointer: PointerInput;
  readonly joystick: JoystickInput;
  private readonly gamepad: GamepadInput;
  private readonly voice: VoiceManager;
  private renderer: import("./render/game-renderer").GameRenderer | undefined;

  private client: GameClient | undefined;
  private destroyed = false;
  private nextSequence = 0;
  private authoritativeInputAngle: number | undefined;
  private lastSentAngle: number | undefined;
  private lastSentBoosting = false;
  private inputSendTimer: ReturnType<typeof setTimeout> | undefined;
  private lastInputSentAt = Number.NEGATIVE_INFINITY;
  /**
   * One input per simulation tick.
   *
   * The simulation only applies the last input scheduled on a tick, so sending
   * faster than the tick rate discards messages and, worse, makes the number of
   * inputs landing per tick alternate whenever the send period does not divide
   * the tick period. That beat turns a steady turn into uneven angle steps.
   */
  private get inputSendIntervalMs(): number {
    return 1000 / this.descriptor.tickRate;
  }
  private readonly unsubscribeInput: () => void;
  private readonly openMenus = new Set<GameMenuId>();
  private readonly menuAutopilot = new MenuAutopilot();
  private menuInputCommand: NetworkInputCommand | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pingNonce = 0;
  private pingSentAt = new Map<string, number>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private killFeedCounter = 0;
  private readonly killFeedTimers = new Set<ReturnType<typeof setTimeout>>();
  private voiceErrorTimer: ReturnType<typeof setTimeout> | undefined;
  private musicErrorTimer: ReturnType<typeof setTimeout> | undefined;
  private respawnTimer: ReturnType<typeof setInterval> | undefined;
  private respawnAtMs = 0;
  private magnetTimer: ReturnType<typeof setInterval> | undefined;
  private magnetExpiresAtMs = 0;

  constructor(
    readonly descriptor: BackendDescriptor,
    readonly session: SessionInfo,
    private readonly settings: SettingsStore,
    private readonly onSessionExpired: () => void,
  ) {
    this.music = new MusicPlayback(() => this.clock.serverNow() ?? Date.now());
    this.predictor = new SelfPredictor(descriptor.rules, descriptor.tickRate);
    this.pointer = new PointerInput(this.input);
    this.joystick = new JoystickInput(this.input);
    this.voice = new VoiceManager(
      () => this.selfId ?? session.playerId,
      {
        onPeersChanged: (peers) => (this.voicePeers = peers),
        onJoinedChanged: (joined) => {
          this.voiceJoined = joined;
        },
        onLocalLevel: (level) => (this.voiceLevel = level),
        onError: (message) => {
          this.voiceError = message;
          if (this.voiceErrorTimer) clearTimeout(this.voiceErrorTimer);
          this.voiceErrorTimer = setTimeout(() => {
            this.voiceError = undefined;
            this.voiceErrorTimer = undefined;
          }, 4000);
        },
        sendVoiceSignal: (target, signal) => this.client?.sendVoiceSignal(target, signal),
        sendVoiceState: (listening, microphoneEnabled) =>
          this.client?.sendVoiceState(listening, microphoneEnabled),
      },
      descriptor.turnCredentialsPath,
    );
    this.sfx.setVolume(settings.sfxVolume);
    this.music.setVolume(settings.musicVolume);
    this.unsubscribeInput = this.input.subscribe(() => this.scheduleInputSend());
    this.gamepad = new GamepadInput(this.input, (gamepad) => {
      this.gamepadConnected = gamepad !== undefined;
      this.gamepadName = gamepad?.id;
    });
    this.connect();
  }

  get snapshotBuffer(): SnapshotBuffer {
    return this.buffer;
  }

  get selfPredictor(): SelfPredictor {
    return this.predictor;
  }

  get clockSync(): ClockSync {
    return this.clock;
  }

  async attachRenderer(host: HTMLElement): Promise<void> {
    let renderer: import("./render/game-renderer").GameRenderer | undefined;
    try {
      const { GameRenderer } = await import("./render/game-renderer");
      if (this.destroyed) return;
      renderer = new GameRenderer(this, this.settings, () => {
        if (!this.destroyed) this.gameReady = true;
      });
      this.renderer = renderer;
      await renderer.init(host);
      if (this.destroyed) return;
      renderer.start();
    } catch {
      renderer?.destroy();
      if (this.destroyed) return;
      this.renderer = undefined;
      this.stopConnectionLoops();
      this.client?.close();
      this.voice.leave();
      this.clearRespawnCountdown();
      this.clearMagnetCountdown();
      this.status = "closed";
      this.notice = "游戏画面加载失败，请刷新后重试";
    }
  }

  toggleVoice(): void {
    if (this.voice.isJoined) this.voice.leave();
    else if (!this.voice.isJoining) void this.voice.join();
  }

  controlMusic(command: MusicControl): void {
    if (command._tag === "play") this.clearMusicError();
    this.client?.sendMusicControl(command);
  }

  requestMusicManager(): void {
    window.dispatchEvent(new CustomEvent(OPEN_MUSIC_MANAGER_EVENT));
  }

  setMenuOpen(menu: GameMenuId, open: boolean): void {
    if (open) this.openMenus.add(menu);
    else this.openMenus.delete(menu);
    this.updateMenuAutopilot();
  }

  setPeerVolume(playerId: PlayerId, volume: number): void {
    this.voice.setPeerVolume(playerId, volume);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.openMenus.clear();
    this.menuAutopilot.reset();
    this.menuInputCommand = undefined;
    this.stopConnectionLoops();
    this.unsubscribeInput();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.respawnTimer) clearInterval(this.respawnTimer);
    if (this.magnetTimer) clearInterval(this.magnetTimer);
    if (this.voiceErrorTimer) clearTimeout(this.voiceErrorTimer);
    if (this.musicErrorTimer) clearTimeout(this.musicErrorTimer);
    for (const timer of this.killFeedTimers) clearTimeout(timer);
    this.killFeedTimers.clear();
    this.voice.dispose();
    this.client?.close();
    this.pointer.dispose();
    this.joystick.detach();
    this.gamepad.dispose();
    this.sfx.dispose();
    this.music.dispose();
    this.renderer?.destroy();
  }

  private connect(): void {
    if (this.destroyed) return;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    this.client = new GameClient(`${protocol}://${location.host}${this.descriptor.websocketPath}`, {
      onMessage: (message) => this.handleMessage(message),
      onClose: (code) => this.handleClose(code),
    });
    this.client.connect();
  }

  private handleMessage(message: ServerMessage): void {
    switch (message._tag) {
      case "welcome":
        this.handleWelcome(message);
        break;
      case "snapshot":
        this.clock.seed(message.serverTime);
        this.handleSnapshot(message.snapshot, message.serverTime, message.events);
        break;
      case "input-ack":
        this.predictor.acknowledgeInput(message.sequence, message.targetTick, message.appliedTick);
        break;
      case "pong": {
        const sentAt = this.pingSentAt.get(message.nonce);
        if (sentAt !== undefined) {
          const rttMs = this.clock.sample(sentAt, message.serverTime);
          this.pingMs = Math.round(rttMs);
          this.predictionLead.addRttSample(rttMs);
          this.predictor.setPredictionLeadTicks(
            this.predictionLead.leadTicks(this.descriptor.tickRate),
          );
          this.pingSentAt.delete(message.nonce);
        }
        break;
      }
      case "voice-roster":
        this.voice.updateRoster(message.voice);
        break;
      case "voice-signal":
        void this.voice.handleSignal(message.fromPlayerId, message.signal);
        break;
      case "music-state":
        this.acceptMusicState(message.music);
        break;
      case "error":
        this.handleServerError(message.code, message.retryable);
        break;
    }
  }

  private handleWelcome(message: Extract<ServerMessage, { _tag: "welcome" }>): void {
    this.selfId = message.selfPlayerId;
    this.clock.seed(message.serverTime);
    const selfSnake = message.snapshot.snakes.find((snake) => snake.id === message.selfPlayerId);
    this.nextSequence = message.resumed && selfSnake ? selfSnake.lastInputSequence + 1 : 0;
    this.status = "online";
    this.reconnectAttempts = 0;
    this.predictor.reset();
    this.predictor.setPredictionLeadTicks(this.predictionLead.leadTicks(this.descriptor.tickRate));
    this.buffer.reset();
    this.pingSentAt.clear();
    this.handleSnapshot(message.snapshot, message.serverTime, []);
    this.acceptMusicState(message.music, true);
    this.voice.handleSignalingReconnect(message.voice);
    void this.voice.startListening();
    this.startLoops();
  }

  private acceptMusicState(state: MusicPlaybackState, force = false): void {
    this.musicState = state;
    this.music.apply(state, force);
  }

  private handleSnapshot(
    snapshot: GameSnapshot,
    serverTime: number,
    events: ReadonlyArray<TickEventBatch>,
  ): void {
    this.latestSnapshot = snapshot;
    this.buffer.push(snapshot, serverTime);

    const selfSnake = snapshot.snakes.find((snake) => snake.id === this.selfId);
    if (selfSnake) {
      const wasAlive = this.self.alive;
      this.authoritativeInputAngle = selfSnake.targetAngle ?? selfSnake.angle;
      this.predictor.reconcile(selfSnake, snapshot.tick, performance.now());
      const becameAlive = selfSnake.alive && !wasAlive;
      const respawnReported = events.some((batch) =>
        batch.respawnedPlayerIds.includes(selfSnake.id),
      );
      // 保留 respawnIn/deathBy：它们分别由倒计时定时器和死亡/重生事件维护，
      // 不能随快照重建，否则 10Hz 快照会把倒计时打回 0、把击杀者名字抹掉
      this.self = {
        ...this.self,
        length: Math.round(selfSnake.length),
        kills: selfSnake.kills,
        score: Math.round(selfSnake.score),
        alive: selfSnake.alive,
      };
      if (becameAlive || respawnReported) this.forceInputResend();
      if (selfSnake.alive && selfSnake.respawnAtTick === null) this.clearRespawnCountdown();
      if (!selfSnake.alive && selfSnake.respawnAtTick != null && !this.respawnTimer) {
        // 重连等场景漏掉死亡事件时，从快照补齐倒计时
        this.startRespawnCountdown(selfSnake.respawnAtTick, snapshot.tick);
      }
      this.syncMagnetCountdown(selfSnake.magnetUntilSourceFrame ?? null, snapshot.tick, serverTime);
    }
    const ranked = rankAliveSnakes(snapshot.snakes);
    this.leaderboard = visibleHudRanks(ranked, this.selfId);
    this.gameMapMarkers = selectGameMapMarkers(ranked, snapshot.snakes, this.selfId);
    this.updateMenuAutopilot();

    this.processEvents(snapshot, events);
  }

  private processEvents(snapshot: GameSnapshot, batches: ReadonlyArray<TickEventBatch>): void {
    const nickOf = (playerId: string): string =>
      snapshot.snakes.find((snake) => snake.id === playerId)?.nickname ?? playerId;

    for (const batch of batches) {
      for (const consumed of batch.consumedFoods) {
        this.renderer?.foodConsumed(consumed);
      }
      for (const consumed of batch.consumedMagnets ?? []) {
        this.renderer?.magnetConsumed(consumed);
      }
      for (const death of batch.deaths) {
        const victim = nickOf(death.playerId);
        const killerId = death.cause._tag === "Snake" ? death.cause.killerId : undefined;
        const killer = killerId === undefined ? undefined : nickOf(killerId);
        this.pushKillFeed(killer ? `${killer} 击杀了 ${victim}` : `${victim} 撞到了边界`);
        if (death.playerId === this.selfId) {
          this.sfx.death();
          this.gamepad.rumbleOnDeath();
          this.self = { ...this.self, deathBy: killer };
          const selfSnake = snapshot.snakes.find((snake) => snake.id === this.selfId);
          if (selfSnake?.respawnAtTick != null) {
            this.startRespawnCountdown(selfSnake.respawnAtTick, snapshot.tick);
          }
        } else if (killerId === this.selfId) {
          this.sfx.kill();
          this.pushKillFeed("漂亮的击杀！", true);
        }
        this.renderer?.snakeDied(death.playerId);
      }
      for (const playerId of batch.respawnedPlayerIds) {
        if (playerId === this.selfId) {
          this.clearRespawnCountdown();
          this.self = { ...this.self, deathBy: undefined };
        }
      }
    }
  }

  private pushKillFeed(text: string, important = false): void {
    const entry = { id: ++this.killFeedCounter, text };
    this.killFeed = [...this.killFeed.slice(-4), entry];
    const timer = setTimeout(
      () => {
        this.killFeedTimers.delete(timer);
        this.killFeed = this.killFeed.filter((item) => item.id !== entry.id);
      },
      important ? 4000 : 3200,
    );
    this.killFeedTimers.add(timer);
  }

  private startRespawnCountdown(respawnAtTick: number, currentTick: number): void {
    if (this.respawnTimer) clearInterval(this.respawnTimer);
    const serverNow = this.clock.serverNow() ?? Date.now();
    this.respawnAtMs =
      serverNow + ((respawnAtTick - currentTick) / this.descriptor.tickRate) * 1000;
    const update = (): void => {
      const now = this.clock.serverNow() ?? Date.now();
      const remaining = Math.max(0, (this.respawnAtMs - now) / 1000);
      this.self = { ...this.self, respawnIn: remaining };
      if (remaining <= 0) this.clearRespawnCountdown();
    };
    update();
    this.respawnTimer = setInterval(update, 100);
  }

  private clearRespawnCountdown(): void {
    if (this.respawnTimer) clearInterval(this.respawnTimer);
    this.respawnTimer = undefined;
    if (this.self.respawnIn !== 0) this.self = { ...this.self, respawnIn: 0 };
  }

  private syncMagnetCountdown(
    untilSourceFrame: number | null,
    snapshotTick: number,
    serverTime: number,
  ): void {
    if (untilSourceFrame === null) {
      this.clearMagnetCountdown();
      return;
    }
    const sourceFramesPerTick = Math.max(1, Math.round(60 / this.descriptor.tickRate));
    this.magnetExpiresAtMs =
      serverTime +
      Math.max(0, untilSourceFrame - snapshotTick * sourceFramesPerTick) * (1_000 / 60);
    if (this.magnetTimer !== undefined) return;
    const update = (): void => {
      const now = this.clock.serverNow() ?? Date.now();
      const remaining = Math.max(0, (this.magnetExpiresAtMs - now) / 1_000);
      this.self = { ...this.self, magnetRemaining: remaining };
      if (remaining <= 0) this.clearMagnetCountdown();
    };
    update();
    this.magnetTimer = setInterval(update, 1_000 / 60);
  }

  private clearMagnetCountdown(): void {
    if (this.magnetTimer) clearInterval(this.magnetTimer);
    this.magnetTimer = undefined;
    if (this.self.magnetRemaining !== 0) {
      this.self = { ...this.self, magnetRemaining: 0 };
    }
  }

  private updateMenuAutopilot(): void {
    if (this.openMenus.size === 0) {
      this.menuAutopilot.reset();
      this.menuInputCommand = undefined;
      this.scheduleInputSend();
      return;
    }
    const snapshot = this.latestSnapshot;
    if (snapshot === undefined) {
      this.menuAutopilot.reset();
      this.menuInputCommand = undefined;
      return;
    }
    this.menuInputCommand = this.menuAutopilot.command(
      snapshot,
      this.selfId,
      this.descriptor.rules.arenaHalfSize,
    );
    this.scheduleInputSend();
  }

  private handleServerError(code: string, retryable: boolean): void {
    if (code === "SESSION_EXPIRED") {
      this.notice = "游戏会话已过期，请返回首页重新进入";
      this.destroy();
      this.onSessionExpired();
      return;
    }
    if (code === "MUSIC_CONTROL_FAILED") {
      this.musicError = "当前音源无法解析这首歌，请更换歌曲或来源";
      if (this.musicErrorTimer) clearTimeout(this.musicErrorTimer);
      this.musicErrorTimer = setTimeout(() => this.clearMusicError(), 5_000);
      return;
    }
    if (code === "NICKNAME_IN_USE") this.notice = "昵称已被占用，请更换昵称";
    else if (code === "RATE_LIMITED") this.notice = "操作太频繁，已被限流";
    else if (code === "STALE_INPUT") {
      this.forceInputResend();
    } else if (!retryable) this.notice = `服务器错误：${code}`;
  }

  private clearMusicError(): void {
    if (this.musicErrorTimer) clearTimeout(this.musicErrorTimer);
    this.musicErrorTimer = undefined;
    this.musicError = undefined;
  }

  private handleClose(code: number): void {
    if (this.destroyed) return;
    this.stopConnectionLoops();
    if (code === 4401) {
      this.notice = "游戏会话已过期，请返回首页重新进入";
      this.destroy();
      this.onSessionExpired();
      return;
    }
    const terminalNotice = terminalGameCloseNotice(code);
    if (terminalNotice !== undefined) {
      this.enterTerminalState(terminalNotice);
      return;
    }
    this.voice.handleSignalingDisconnect();
    this.scheduleReconnect(code === 4429 ? 10_000 : undefined);
  }

  private enterTerminalState(notice: string): void {
    this.voice.leave();
    this.clearRespawnCountdown();
    this.clearMagnetCountdown();
    this.status = "closed";
    this.notice = notice;
  }

  private stopConnectionLoops(): void {
    if (this.inputSendTimer) clearTimeout(this.inputSendTimer);
    this.inputSendTimer = undefined;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.pingSentAt.clear();
  }

  private scheduleReconnect(forcedDelay?: number): void {
    if (this.destroyed) return;
    this.status = "reconnecting";
    this.reconnectAttempts += 1;
    const delay = forcedDelay ?? Math.min(8_000, 500 * 2 ** Math.min(this.reconnectAttempts, 4));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private scheduleInputSend(): void {
    if (
      this.destroyed ||
      this.status !== "online" ||
      !this.client?.connected ||
      !this.self.alive ||
      this.pendingInputCommand() === undefined
    ) {
      return;
    }
    if (this.inputSendTimer) return;

    const elapsed = performance.now() - this.lastInputSentAt;
    const delay = Math.max(0, this.inputSendIntervalMs - elapsed);
    if (delay === 0) {
      this.flushInput();
      return;
    }
    this.inputSendTimer = setTimeout(() => {
      this.inputSendTimer = undefined;
      this.flushInput();
    }, delay);
  }

  private flushInput(): void {
    if (this.status !== "online" || !this.client?.connected || !this.self.alive) return;
    const command = this.pendingInputCommand();
    if (!command) return;

    this.lastSentAngle = command.angle;
    this.lastSentBoosting = command.boosting;
    this.lastInputSentAt = performance.now();
    const sequence = this.nextSequence++;
    const targetTick = this.predictor.nextInputTick;
    this.predictor.scheduleInput({
      sequence,
      targetTick,
      angle: command.angle,
      boosting: command.boosting,
    });
    this.client.sendInput(sequence, targetTick, command.angle, command.boosting);
  }

  private pendingInputCommand(): NetworkInputCommand | undefined {
    const command = this.menuInputCommand;
    const activeInput =
      command === undefined
        ? this.input
        : { angle: command.angle, boosting: command.boosting, hasDirection: true };
    return nextNetworkInput(
      activeInput,
      this.authoritativeInputAngle,
      { angle: this.lastSentAngle, boosting: this.lastSentBoosting },
      INPUT.angleEpsilon,
    );
  }

  /** 死亡期间服务端拒绝输入；重生后必须重发仍按住的方向。 */
  private forceInputResend(): void {
    if (this.inputSendTimer) clearTimeout(this.inputSendTimer);
    this.inputSendTimer = undefined;
    this.lastSentAngle = undefined;
    this.lastSentBoosting = false;
    this.lastInputSentAt = Number.NEGATIVE_INFINITY;
    this.scheduleInputSend();
  }

  private startLoops(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.forceInputResend();

    const sendPing = (): void => {
      if (!this.client?.connected) return;
      const nonce = `p${++this.pingNonce}`;
      this.pingSentAt.set(nonce, Date.now());
      this.client.sendPing(nonce);
    };
    sendPing();
    this.pingTimer = setInterval(sendPing, INPUT.pingIntervalMs);
  }
}
