import { Effect } from "effect";
import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import {
  GAME_PROTOCOL_VERSION,
  MAX_CLIENT_MESSAGE_BYTES,
  decodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type ServerErrorCode,
  type ServerMessage,
  type TickEventBatch,
  type VoiceSignal,
} from "../../protocol";
import { AccessAttemptLimiter } from "../access/attempt-limiter";
import { defaultGameConfig } from "../game/config";
import { GameEngine } from "../game/engine";
import { VoiceRoster } from "../voice/voice-roster";
import { readPlayerIdentity, type ConnectionIdentity } from "./connection-identity";
import { ConnectionTrafficGuard, type MessageCategory } from "./connection-traffic-guard";
import { RoomController } from "./room-controller";
import { RECONNECT_GRACE_TICKS, ROOM_METADATA, SNAPSHOT_RATE } from "./room-settings";

type RoomConnection = Connection<ConnectionIdentity>;

const MAX_CATCH_UP_TICKS = 5;

export class GameRoom extends Server<Env> {
  static options = { hibernate: true };

  private readonly controller = new RoomController(
    new GameEngine(defaultGameConfig, 0x5eed),
    RECONNECT_GRACE_TICKS,
  );
  private readonly voiceRoster = new VoiceRoster();
  private readonly accessAttemptLimiter = new AccessAttemptLimiter();
  private readonly turnCredentialAttemptLimiter = new AccessAttemptLimiter(12, 10 * 60_000);
  private readonly trafficGuard = new ConnectionTrafficGuard();
  private readonly pendingEvents: Array<TickEventBatch> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextTickAt = 0;

  override onStart(): void {
    for (const connection of this.getConnections<ConnectionIdentity>()) {
      const identity = connection.state;
      if (identity === null) continue;
      if (identity.sessionExpiresAt <= Date.now()) {
        this.sendError(connection, "SESSION_EXPIRED", true);
        connection.close(4401, "Session expired");
        continue;
      }
      const result = this.controller.join(connection.id, identity);
      if (result._tag === "Rejected") {
        connection.close(4409, "Nickname is already in use");
        continue;
      }
      this.voiceRoster.join(identity.playerId, identity.nickname);
    }
    if (this.controller.shouldRun) this.startLoop();
  }

  override onRequest(request: Request): Response {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });

    const pathname = new URL(request.url).pathname;
    if (pathname === "/__access-attempt") {
      const source = request.headers.get("x-serpentia-source") ?? "unknown";
      return this.accessAttemptLimiter.allow(source)
        ? new Response(null, { status: 204 })
        : new Response("Too many attempts", { status: 429 });
    }
    if (pathname === "/__turn-credential-attempt") {
      const playerId = request.headers.get("x-serpentia-player-id") ?? "unknown";
      return this.turnCredentialAttemptLimiter.allow(playerId)
        ? new Response(null, { status: 204 })
        : new Response("Too many attempts", { status: 429 });
    }
    return new Response("Not found", { status: 404 });
  }

  override onConnect(connection: RoomConnection, context: ConnectionContext): void {
    const identity = readPlayerIdentity(context.request);
    if (identity === undefined) {
      connection.close(4401, "A valid game session is required");
      return;
    }

    const result = this.controller.join(connection.id, identity);
    if (result._tag === "Rejected") {
      this.sendError(connection, result.reason, false);
      connection.close(4409, "Nickname is already in use");
      return;
    }

    connection.setState(identity);
    this.voiceRoster.join(identity.playerId, identity.nickname);
    if (result.replacedConnectionId !== undefined) {
      this.getConnection(result.replacedConnectionId)?.close(4001, "Reconnected elsewhere");
    }

    this.send(connection, {
      v: GAME_PROTOCOL_VERSION,
      _tag: "welcome",
      selfPlayerId: identity.playerId,
      resumed: result.resumed,
      sessionExpiresAt: identity.sessionExpiresAt,
      serverTime: Date.now(),
      room: ROOM_METADATA,
      snapshot: result.snapshot,
      voice: this.voiceRoster.snapshot(),
    });
    this.broadcastVoiceRoster([connection.id]);
    this.startLoop();
  }

  override onMessage(connection: RoomConnection, message: WSMessage): void {
    if (connection.state !== null && connection.state.sessionExpiresAt <= Date.now()) {
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

  override onClose(connection: RoomConnection): void {
    this.trafficGuard.forget(connection.id);
    const left = this.controller.leave(connection.id);
    if (left && connection.state !== null) {
      this.voiceRoster.leave(connection.state.playerId);
      this.broadcastVoiceRoster();
    }
    if (!this.controller.shouldRun) this.stopLoop();
  }

  override onError(connection: RoomConnection, error: unknown): void {
    console.error(
      JSON.stringify({
        level: "error",
        event: "game_room_websocket_error",
        connectionId: connection.id,
        error: String(error),
      }),
    );
    connection.close(1011, "WebSocket transport error");
  }

  override onException(error: unknown): void {
    console.error(
      JSON.stringify({
        level: "error",
        event: "game_room_exception",
        error: String(error),
      }),
    );
  }

  private handleMessage(connection: RoomConnection, message: ClientMessage): void {
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

  private handleVoiceState(connection: RoomConnection, muted: boolean): void {
    const identity = connection.state;
    if (
      identity === null ||
      !this.controller.isCurrentConnection(connection.id, identity.playerId) ||
      !this.voiceRoster.setMuted(identity.playerId, muted)
    ) {
      this.sendError(connection, "VOICE_NOT_AUTHORIZED", false);
      return;
    }
    this.broadcastVoiceRoster();
  }

  private forwardVoiceSignal(
    connection: RoomConnection,
    targetPlayerId: string,
    signal: VoiceSignal,
  ): void {
    const identity = connection.state;
    if (
      identity === null ||
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
      targetConnectionId === undefined
        ? undefined
        : this.getConnection<ConnectionIdentity>(targetConnectionId);
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
      this.broadcast(
        encodeServerMessage({
          v: GAME_PROTOCOL_VERSION,
          _tag: "snapshot",
          serverTime: Date.now(),
          snapshot: this.controller.snapshot(),
          events: this.pendingEvents.splice(0),
        }),
      );
    }
    if (!this.controller.shouldRun) this.stopLoop();
  }

  private tickDurationMilliseconds(): number {
    return 1_000 / defaultGameConfig.tickRate;
  }

  private closeExpiredSessions(): void {
    const now = Date.now();
    for (const connection of this.getConnections<ConnectionIdentity>()) {
      if (connection.state === null || connection.state.sessionExpiresAt > now) continue;
      this.sendError(connection, "SESSION_EXPIRED", true);
      connection.close(4401, "Session expired");
    }
  }

  private broadcastVoiceRoster(without?: Array<string>): void {
    this.broadcast(
      encodeServerMessage({
        v: GAME_PROTOCOL_VERSION,
        _tag: "voice-roster",
        voice: this.voiceRoster.snapshot(),
      }),
      without,
    );
  }

  private rejectRateLimitedConnection(connection: RoomConnection): void {
    this.sendError(connection, "RATE_LIMITED", true);
    connection.close(4429, "Message rate limit exceeded");
  }

  private sendError(connection: RoomConnection, code: ServerErrorCode, retryable: boolean): void {
    this.send(connection, { v: GAME_PROTOCOL_VERSION, _tag: "error", code, retryable });
  }

  private send(connection: RoomConnection, message: ServerMessage): void {
    connection.send(encodeServerMessage(message));
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
