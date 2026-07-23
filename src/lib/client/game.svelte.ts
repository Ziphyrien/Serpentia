import type {
  BackendDescriptor,
  GameSnapshot,
  ServerMessage,
  SessionInfo,
  TickEventBatch,
  VoiceSignal,
} from "$lib/protocol";
import type { PlayerId } from "$lib/protocol/state";
import { INPUT } from "./config";
import { ClockSync } from "./net/clock-sync";
import { GameClient } from "./net/game-client";
import { SnapshotBuffer } from "./sim/snapshot-buffer";
import { SelfPredictor } from "./sim/self-predictor";
import { InputState } from "./input/input-state";
import { PointerInput } from "./input/pointer-input";
import { JoystickInput } from "./input/joystick-input";
import { Sfx } from "./audio/sfx";
import { normalizeAngle } from "../game/snake-motion";
import { VoiceManager, type VoicePeerView } from "./voice/voice-manager";
import type { SettingsStore } from "./stores/settings.svelte";

export type ConnectionStatus = "connecting" | "online" | "reconnecting" | "closed";

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

  status = $state<ConnectionStatus>("connecting");
  selfId = $state<PlayerId | undefined>(undefined);
  leaderboard = $state<
    Array<{ playerId: string; nickname: string; length: number; kills: number }>
  >([]);
  self = $state<HudSelf>({ length: 0, kills: 0, score: 0, alive: true, respawnIn: 0 });
  killFeed = $state<Array<KillFeedEntry>>([]);
  pingMs = $state(0);
  voicePeers = $state<Array<VoicePeerView>>([]);
  voiceJoined = $state(false);
  voiceMuted = $state(false);
  voiceError = $state<string | undefined>(undefined);
  notice = $state<string | undefined>(undefined);
  /** 蛇头接近场地边界（渲染层每帧更新，HUD 显示红晕警告）。 */
  nearBoundary = $state(false);

  /** 渲染层直读的最新快照（非响应式，避免 10Hz 大对象进入依赖图）。 */
  latestSnapshot: GameSnapshot | undefined;

  private readonly clock = new ClockSync();
  private readonly buffer = new SnapshotBuffer(() => this.selfId);
  private readonly predictor: SelfPredictor;
  private readonly pointer: PointerInput;
  readonly joystick: JoystickInput;
  private readonly voice: VoiceManager;
  private renderer: import("./render/game-renderer").GameRenderer | undefined;

  private client: GameClient | undefined;
  private destroyed = false;
  private nextSequence = 0;
  private lastSnapshotTick = 0;
  private lastSentAngle: number | undefined;
  private lastSentBoosting = false;
  private inputSendTimer: ReturnType<typeof setTimeout> | undefined;
  private lastInputSentAt = Number.NEGATIVE_INFINITY;
  private readonly unsubscribeInput: () => void;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pingNonce = 0;
  private pingSentAt = new Map<string, number>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private killFeedCounter = 0;
  private respawnTimer: ReturnType<typeof setInterval> | undefined;
  private respawnAtMs = 0;
  private lastFoodCount = 0;
  private lastWarnAt = 0;

  constructor(
    readonly descriptor: BackendDescriptor,
    readonly session: SessionInfo,
    private readonly settings: SettingsStore,
    private readonly onSessionExpired: () => void,
  ) {
    this.predictor = new SelfPredictor(descriptor.rules, descriptor.tickRate);
    this.pointer = new PointerInput(this.input);
    this.joystick = new JoystickInput(this.input);
    this.voice = new VoiceManager(() => this.selfId ?? session.playerId, {
      onPeersChanged: (peers) => (this.voicePeers = peers),
      onJoinedChanged: (joined, muted) => {
        this.voiceJoined = joined;
        this.voiceMuted = muted;
      },
      onError: (message) => {
        this.voiceError = message;
        window.setTimeout(() => (this.voiceError = undefined), 4000);
      },
      sendVoiceSignal: (target, signal) => this.client?.sendVoiceSignal(target, signal),
      sendVoiceState: (muted) => this.client?.sendVoiceState(muted),
    });
    this.sfx.setVolume(settings.sfxVolume);
    this.sfx.setMuted(settings.sfxMuted);
    this.unsubscribeInput = this.input.subscribe(() => this.scheduleInputSend());
    this.connect();
  }

  /** 供 HUD 查询当前语音成员（含自己）。 */
  get voiceManager(): VoiceManager {
    return this.voice;
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
    const { GameRenderer } = await import("./render/game-renderer");
    if (this.destroyed) return;
    this.renderer = new GameRenderer(this, this.settings);
    await this.renderer.init(host);
    this.renderer.start();
  }

  toggleVoice(): void {
    if (this.voiceJoined) this.voice.leave();
    else void this.voice.join();
  }

  setVoiceMuted(muted: boolean): void {
    this.voice.setMuted(muted);
  }

  setPeerVolume(playerId: PlayerId, volume: number): void {
    this.voice.setPeerVolume(playerId, volume);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.inputSendTimer) clearTimeout(this.inputSendTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.unsubscribeInput();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.respawnTimer) clearInterval(this.respawnTimer);
    this.client?.close();
    this.pointer.dispose();
    this.joystick.detach();
    this.voice.dispose();
    this.sfx.dispose();
    this.renderer?.destroy();
  }

  private connect(): void {
    if (this.destroyed) return;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    this.client = new GameClient(`${protocol}://${location.host}${this.descriptor.websocketPath}`, {
      onOpen: () => {},
      onMessage: (message) => this.handleMessage(message),
      onClose: (code, reason) => this.handleClose(code, reason),
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
      case "pong": {
        const sentAt = this.pingSentAt.get(message.nonce);
        if (sentAt !== undefined) {
          this.pingMs = Math.round(this.clock.sample(sentAt, message.serverTime));
          this.pingSentAt.delete(message.nonce);
        }
        break;
      }
      case "voice-roster":
        this.voice.updateRoster(message.voice);
        break;
      case "voice-signal":
        void this.voice.handleSignal(message.fromPlayerId, message.signal as VoiceSignal);
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
    this.handleSnapshot(message.snapshot, message.serverTime, []);
    this.voice.updateRoster(message.voice);
    this.startLoops();
  }

  private handleSnapshot(
    snapshot: GameSnapshot,
    serverTime: number,
    events: ReadonlyArray<TickEventBatch>,
  ): void {
    this.latestSnapshot = snapshot;
    this.lastSnapshotTick = snapshot.tick;
    this.buffer.push(snapshot, serverTime);

    const selfSnake = snapshot.snakes.find((snake) => snake.id === this.selfId);
    if (selfSnake) {
      const wasAlive = this.self.alive;
      this.predictor.reconcile(selfSnake, snapshot.tick, performance.now());
      // 保留 respawnIn/deathBy：它们分别由倒计时定时器和死亡/重生事件维护，
      // 不能随快照重建，否则 10Hz 快照会把倒计时打回 0、把击杀者名字抹掉
      this.self = {
        ...this.self,
        length: Math.round(selfSnake.length),
        kills: selfSnake.kills,
        score: Math.round(selfSnake.score),
        alive: selfSnake.alive,
      };
      if (selfSnake.alive && !wasAlive) this.sfx.respawn();
      if (selfSnake.alive && selfSnake.respawnAtTick === null) this.clearRespawnCountdown();
      if (!selfSnake.alive && selfSnake.respawnAtTick != null && !this.respawnTimer) {
        // 重连等场景漏掉死亡事件时，从快照补齐倒计时
        this.startRespawnCountdown(selfSnake.respawnAtTick, snapshot.tick);
      }
    }
    this.leaderboard = snapshot.leaderboard.slice(0, 10).map((entry) => ({
      playerId: entry.playerId,
      nickname: entry.nickname,
      length: Math.round(entry.length),
      kills: entry.kills,
    }));

    this.processEvents(snapshot, events);

    // 进食音效：自己附近的食物消失才播
    if (snapshot.foods.length < this.lastFoodCount && selfSnake?.alive) {
      // 事件里有具体 id，这里只是兜底音量控制
    }
    this.lastFoodCount = snapshot.foods.length;
  }

  private processEvents(snapshot: GameSnapshot, batches: ReadonlyArray<TickEventBatch>): void {
    const nickOf = (playerId: string): string =>
      snapshot.snakes.find((snake) => snake.id === playerId)?.nickname ?? playerId;

    for (const batch of batches) {
      for (const foodId of batch.consumedFoodIds) {
        this.renderer?.foodConsumed(foodId);
      }
      for (const death of batch.deaths) {
        const victim = nickOf(death.playerId);
        const killer = death.cause._tag === "Snake" ? nickOf(death.cause.killerId) : undefined;
        this.pushKillFeed(killer ? `${killer} 击杀了 ${victim}` : `${victim} 撞到了边界`);
        if (death.playerId === this.selfId) {
          this.predictor.markDead();
          this.sfx.death();
          this.self = { ...this.self, alive: false, deathBy: killer };
          const selfSnake = snapshot.snakes.find((snake) => snake.id === this.selfId);
          if (selfSnake?.respawnAtTick != null) {
            this.startRespawnCountdown(selfSnake.respawnAtTick, snapshot.tick);
          }
        } else if (killer === this.selfId) {
          this.sfx.kill();
          this.pushKillFeed("漂亮的击杀！", true);
        }
        this.renderer?.snakeDied(death.playerId);
      }
      for (const playerId of batch.respawnedPlayerIds) {
        if (playerId === this.selfId) {
          this.clearRespawnCountdown();
          this.self = { ...this.self, alive: true, deathBy: undefined };
        }
      }
    }
  }

  private pushKillFeed(text: string, important = false): void {
    const entry = { id: ++this.killFeedCounter, text };
    this.killFeed = [...this.killFeed.slice(-4), entry];
    window.setTimeout(
      () => {
        this.killFeed = this.killFeed.filter((item) => item.id !== entry.id);
      },
      important ? 4000 : 3200,
    );
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

  private handleServerError(code: string, retryable: boolean): void {
    if (code === "SESSION_EXPIRED") {
      this.notice = "登录已过期，请重新登录";
      this.destroy();
      this.onSessionExpired();
      return;
    }
    if (code === "NICKNAME_IN_USE") this.notice = "昵称被占用，请换一个";
    else if (code === "RATE_LIMITED") this.notice = "操作太频繁，已被限流";
    else if (!retryable) this.notice = `服务器错误：${code}`;
  }

  private handleClose(code: number, reason: string): void {
    if (this.destroyed) return;
    if (code === 4001) {
      this.status = "closed";
      this.notice = "此账号已在其他窗口登录";
      return;
    }
    if (code === 4409) {
      this.status = "closed";
      this.notice = reason || "昵称被占用";
      return;
    }
    this.scheduleReconnect(code === 4429 ? 10_000 : undefined);
  }

  private scheduleReconnect(forcedDelay?: number): void {
    if (this.destroyed) return;
    this.status = "reconnecting";
    this.reconnectAttempts += 1;
    const delay = forcedDelay ?? Math.min(8_000, 500 * 2 ** Math.min(this.reconnectAttempts, 4));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private scheduleInputSend(): void {
    if (this.destroyed || !this.client?.connected || !this.input.hasDirection) return;
    if (this.inputSendTimer) return;

    const elapsed = performance.now() - this.lastInputSentAt;
    const delay = Math.max(0, INPUT.sendIntervalMs - elapsed);
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
    if (!this.client?.connected || !this.input.hasDirection) return;
    const angleChanged =
      this.lastSentAngle === undefined ||
      Math.abs(normalizeAngle(this.input.angle - this.lastSentAngle)) > INPUT.angleEpsilon;
    const boostChanged = this.input.boosting !== this.lastSentBoosting;
    if (!angleChanged && !boostChanged) return;

    this.lastSentAngle = this.input.angle;
    this.lastSentBoosting = this.input.boosting;
    this.lastInputSentAt = performance.now();
    this.client.sendInput(
      this.nextSequence++,
      this.lastSnapshotTick,
      this.input.angle,
      this.input.boosting,
    );
  }

  private startLoops(): void {
    if (this.inputSendTimer) clearTimeout(this.inputSendTimer);
    this.inputSendTimer = undefined;
    if (this.pingTimer) clearInterval(this.pingTimer);

    this.lastSentAngle = undefined;
    this.lastSentBoosting = false;
    this.lastInputSentAt = Number.NEGATIVE_INFINITY;
    this.scheduleInputSend();

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
