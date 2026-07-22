import { Effect } from "effect";
import {
  GAME_PROTOCOL_VERSION,
  MAX_CLIENT_MESSAGE_BYTES,
  decodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type RoomMetadata,
  type ServerErrorCode,
  type ServerMessage,
  type TickEventBatch,
  type VoiceSignal,
} from "../../protocol";
import { defaultGameConfig } from "../game/config";
import { GameEngine } from "../game/engine";
import { VoiceRoster } from "../voice/voice-roster";
import type { ConnectionIdentity } from "./connection-identity";
import { ConnectionTrafficGuard, type MessageCategory } from "./connection-traffic-guard";
import { RoomController } from "./room-controller";
import { RECONNECT_GRACE_TICKS, ROOM_METADATA, SNAPSHOT_RATE } from "./room-settings";

const MAX_CATCH_UP_TICKS = 5;

/** Bun WebSocket 与游戏房间之间的最小传输契约。 */
export interface GameRoomConnection {
  readonly id: string;
  readonly identity: ConnectionIdentity;
  send(message: string): void;
  close(code: number, reason: string): void;
}

/**
 * 进程内权威房间。只依赖最小连接接口，不依赖具体宿主运行时。
 * 单 VPS 由一个实例承载 friends 房间。
 */
export class GameRoom {
  private readonly controller = new RoomController(
    new GameEngine(defaultGameConfig, 0x5eed),
    RECONNECT_GRACE_TICKS,
  );
  private readonly voiceRoster = new VoiceRoster();
  private readonly trafficGuard = new ConnectionTrafficGuard();
  private readonly connections = new Map<string, GameRoomConnection>();
  private readonly pendingEvents: Array<TickEventBatch> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextTickAt = 0;

  constructor(private readonly metadata: RoomMetadata = ROOM_METADATA) {}

  connect(connection: GameRoomConnection): void {
    const identity = connection.identity;
    if (identity.sessionExpiresAt <= Date.now()) {
      this.sendError(connection, "SESSION_EXPIRED", true);
      connection.close(4401, "Session expired");
      return;
    }

    const result = this.controller.join(connection.id, identity);
    if (result._tag === "Rejected") {
      this.sendError(connection, result.reason, false);
      connection.close(4409, "Nickname is already in use");
      return;
    }

    this.connections.set(connection.id, connection);
    this.voiceRoster.join(identity.playerId, identity.nickname);
    if (result.replacedConnectionId !== undefined) {
      this.connections.get(result.replacedConnectionId)?.close(4001, "Reconnected elsewhere");
    }

    this.send(connection, {
      v: GAME_PROTOCOL_VERSION,
      _tag: "welcome",
      selfPlayerId: identity.playerId,
      resumed: result.resumed,
      sessionExpiresAt: identity.sessionExpiresAt,
      serverTime: Date.now(),
      room: this.metadata,
      snapshot: result.snapshot,
      voice: this.voiceRoster.snapshot(),
    });
    this.broadcastVoiceRoster(connection.id);
    this.startLoop();
  }

  receive(connectionId: string, message: string | Uint8Array): void {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) return;

    if (connection.identity.sessionExpiresAt <= Date.now()) {
      this.sendError(connection, "SESSION_EXPIRED", true);
      connection.close(4401, "Session expired");
      return;
    }
    if (typeof message !== "string") {
      connection.close(4400, "Only text protocol messages are supported");
      return;
    }
    if (byteLength(message) > MAX_CLIENT_MESSAGE_BYTES) {
      this.sendError(connection, "MESSAGE_TOO_LARGE", false);
      connection.close(4400, "Message is too large");
      return;
    }
    if (!this.trafficGuard.allowTotal(connection.id)) {
      this.rejectRateLimitedConnection(connection);
      return;
    }

    let decoded: ClientMessage;
    try {
      decoded = Effect.runSync(decodeClientMessage(message));
    } catch {
      this.sendError(connection, "INVALID_MESSAGE", false);
      if (this.trafficGuard.recordInvalid(connection.id)) {
        connection.close(4400, "Too many invalid messages");
      }
      return;
    }

    if (!this.trafficGuard.allowCategory(connection.id, messageCategory(decoded))) {
      this.rejectRateLimitedConnection(connection);
      return;
    }
    this.handleMessage(connection, decoded);
  }

  disconnect(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) return;
    this.connections.delete(connectionId);
    this.trafficGuard.forget(connectionId);

    const left = this.controller.leave(connectionId);
    if (left) {
      this.voiceRoster.leave(connection.identity.playerId);
      this.broadcastVoiceRoster();
    }
    if (!this.controller.shouldRun) this.stopLoop();
  }

  reportError(connectionId: string, error: unknown): void {
    console.error(
      JSON.stringify({
        level: "error",
        event: "game_room_websocket_error",
        connectionId,
        error: String(error),
      }),
    );
    this.connections.get(connectionId)?.close(1011, "WebSocket transport error");
  }

  dispose(): void {
    this.stopLoop();
    for (const connection of this.connections.values()) {
      connection.close(1001, "Server shutting down");
    }
    this.connections.clear();
  }

  private handleMessage(connection: GameRoomConnection, message: ClientMessage): void {
    switch (message._tag) {
      case "ping":
        this.send(connection, {
          v: GAME_PROTOCOL_VERSION,
          _tag: "pong",
          nonce: message.nonce,
          serverTime: Date.now(),
        });
        return;
      case "voice-state":
        this.handleVoiceState(connection, message.muted);
        return;
      case "voice-signal":
        this.forwardVoiceSignal(connection, message.targetPlayerId, message.signal);
        return;
      case "input": {
        const accepted = this.controller.applyInput(connection.id, {
          sequence: message.sequence,
          clientTick: message.clientTick,
          angle: message.angle,
          boosting: message.boosting,
        });
        if (!accepted) this.sendError(connection, "STALE_INPUT", true);
      }
    }
  }

  private handleVoiceState(connection: GameRoomConnection, muted: boolean): void {
    const identity = connection.identity;
    if (
      !this.controller.isCurrentConnection(connection.id, identity.playerId) ||
      !this.voiceRoster.setMuted(identity.playerId, muted)
    ) {
      this.sendError(connection, "VOICE_NOT_AUTHORIZED", false);
      return;
    }
    this.broadcastVoiceRoster();
  }

  private forwardVoiceSignal(
    connection: GameRoomConnection,
    targetPlayerId: string,
    signal: VoiceSignal,
  ): void {
    const identity = connection.identity;
    if (
      !this.controller.isCurrentConnection(connection.id, identity.playerId) ||
      !this.voiceRoster.has(identity.playerId)
    ) {
      this.sendError(connection, "VOICE_NOT_AUTHORIZED", false);
      return;
    }
    if (targetPlayerId === identity.playerId) {
      this.sendError(connection, "VOICE_SELF_TARGET", false);
      return;
    }

    const targetConnectionId = this.controller.connectionIdForPlayer(targetPlayerId);
    const target =
      targetConnectionId === undefined ? undefined : this.connections.get(targetConnectionId);
    if (target === undefined || !this.voiceRoster.has(targetPlayerId)) {
      this.sendError(connection, "VOICE_TARGET_UNAVAILABLE", true);
      return;
    }

    this.send(target, {
      v: GAME_PROTOCOL_VERSION,
      _tag: "voice-signal",
      fromPlayerId: identity.playerId,
      signal,
    });
  }

  private startLoop(): void {
    if (this.timer !== undefined || !this.controller.shouldRun) return;
    this.nextTickAt = Date.now() + this.tickDurationMilliseconds();
    this.scheduleNextTick();
  }

  private stopLoop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextTickAt = 0;
  }

  private scheduleNextTick(): void {
    if (!this.controller.shouldRun) {
      this.stopLoop();
      return;
    }
    const delay = Math.max(0, this.nextTickAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.runDueTicks();
    }, delay);
  }

  private runDueTicks(): void {
    const now = Date.now();
    const tickDuration = this.tickDurationMilliseconds();
    let processed = 0;

    while (now >= this.nextTickAt && processed < MAX_CATCH_UP_TICKS) {
      this.step();
      this.nextTickAt += tickDuration;
      processed += 1;
    }
    if (processed === MAX_CATCH_UP_TICKS && now >= this.nextTickAt) {
      this.nextTickAt = now + tickDuration;
    }
    this.scheduleNextTick();
  }

  private step(): void {
    this.closeExpiredSessions();
    const result = this.controller.tick();
    this.pendingEvents.push({ tick: this.controller.currentTick, ...result.events });

    const snapshotInterval = Math.max(1, Math.round(defaultGameConfig.tickRate / SNAPSHOT_RATE));
    const urgent =
      result.events.deaths.length > 0 ||
      result.events.respawnedPlayerIds.length > 0 ||
      result.expiredPlayerIds.length > 0;
    if (urgent || this.controller.currentTick % snapshotInterval === 0) {
      this.broadcast({
        v: GAME_PROTOCOL_VERSION,
        _tag: "snapshot",
        serverTime: Date.now(),
        snapshot: this.controller.snapshot(),
        events: this.pendingEvents.splice(0),
      });
    }
    if (!this.controller.shouldRun) this.stopLoop();
  }

  private tickDurationMilliseconds(): number {
    return 1_000 / defaultGameConfig.tickRate;
  }

  private closeExpiredSessions(): void {
    const now = Date.now();
    for (const connection of this.connections.values()) {
      if (connection.identity.sessionExpiresAt > now) continue;
      this.sendError(connection, "SESSION_EXPIRED", true);
      connection.close(4401, "Session expired");
    }
  }

  private broadcastVoiceRoster(withoutConnectionId?: string): void {
    this.broadcast(
      {
        v: GAME_PROTOCOL_VERSION,
        _tag: "voice-roster",
        voice: this.voiceRoster.snapshot(),
      },
      withoutConnectionId,
    );
  }

  private broadcast(message: ServerMessage, withoutConnectionId?: string): void {
    const encoded = encodeServerMessage(message);
    for (const connection of this.connections.values()) {
      if (connection.id === withoutConnectionId) continue;
      try {
        connection.send(encoded);
      } catch (error) {
        this.reportError(connection.id, error);
      }
    }
  }

  private rejectRateLimitedConnection(connection: GameRoomConnection): void {
    this.sendError(connection, "RATE_LIMITED", true);
    connection.close(4429, "Message rate limit exceeded");
  }

  private sendError(
    connection: GameRoomConnection,
    code: ServerErrorCode,
    retryable: boolean,
  ): void {
    this.send(connection, { v: GAME_PROTOCOL_VERSION, _tag: "error", code, retryable });
  }

  private send(connection: GameRoomConnection, message: ServerMessage): void {
    try {
      connection.send(encodeServerMessage(message));
    } catch (error) {
      this.reportError(connection.id, error);
    }
  }
}

function messageCategory(message: ClientMessage): MessageCategory {
  if (message._tag === "input") return "input";
  if (message._tag === "voice-signal") return "voice-signal";
  return "control";
}

function byteLength(message: string): number {
  return new TextEncoder().encode(message).byteLength;
}
