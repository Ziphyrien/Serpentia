import { Effect } from "effect";
import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { defaultGameConfig } from "../game/config";
import { GameEngine } from "../game/engine";
import { decodeClientMessage, type ClientMessage } from "../protocol/client-message";
import { readPlayerIdentity } from "./connection-identity";
import { RoomController, type PlayerIdentity } from "./room-controller";
import { AccessAttemptLimiter } from "../access/attempt-limiter";
import { VoiceRoster } from "../voice/voice-roster";

type RoomConnection = Connection<PlayerIdentity>;

export class GameRoom extends Server<Env> {
  static options = { hibernate: true };

  private readonly controller = new RoomController(new GameEngine(defaultGameConfig, 0x5eed));
  private readonly voiceRoster = new VoiceRoster();
  private readonly accessAttemptLimiter = new AccessAttemptLimiter();
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickCounter = 0;

  override onRequest(request: Request): Response {
    if (new URL(request.url).pathname !== "/__access-attempt" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    const source = request.headers.get("x-serpentia-source") ?? "unknown";
    return this.accessAttemptLimiter.allow(source)
      ? new Response(null, { status: 204 })
      : new Response("Too many attempts", { status: 429 });
  }

  override onConnect(connection: RoomConnection, context: ConnectionContext): void {
    const identity = readPlayerIdentity(context.request);
    if (identity === undefined) {
      connection.close(4401, "A valid game session is required");
      return;
    }

    const result = this.controller.join(connection.id, identity);
    this.voiceRoster.join(identity.playerId, identity.nickname);
    connection.setState(identity);
    if (result.replacedConnectionId !== undefined) {
      this.getConnection(result.replacedConnectionId)?.close(4001, "Reconnected elsewhere");
    }

    connection.send(JSON.stringify({
      _tag: "welcome",
      snapshot: result.snapshot,
      voice: this.voiceRoster.snapshot(),
    }));
    this.startLoop();
  }

  override async onMessage(connection: RoomConnection, message: WSMessage): Promise<void> {
    if (typeof message !== "string") {
      connection.close(4400, "Only text protocol messages are supported");
      return;
    }

    try {
      const decoded = await Effect.runPromise(decodeClientMessage(message));
      this.handleMessage(connection, decoded);
    } catch {
      connection.send(JSON.stringify({ _tag: "error", code: "INVALID_MESSAGE" }));
    }
  }

  override onClose(connection: RoomConnection): void {
    const left = this.controller.leave(connection.id);
    if (left && connection.state !== null) {
      this.voiceRoster.leave(connection.state.playerId);
      this.broadcast(JSON.stringify({ _tag: "voice-roster", voice: this.voiceRoster.snapshot() }));
    }
    if (this.controller.connectionCount === 0) this.stopLoop();
  }

  private handleMessage(connection: RoomConnection, message: ClientMessage): void {
    if (message._tag === "ping") {
      connection.send(JSON.stringify({ _tag: "pong", nonce: message.nonce }));
      return;
    }

    if (message._tag === "voice-state") {
      const identity = connection.state;
      if (identity === null || !this.voiceRoster.setMuted(identity.playerId, message.muted)) {
        connection.send(JSON.stringify({ _tag: "error", code: "VOICE_NOT_AUTHORIZED" }));
        return;
      }
      this.broadcast(JSON.stringify({ _tag: "voice-roster", voice: this.voiceRoster.snapshot() }));
      return;
    }

    const accepted = this.controller.applyInput(connection.id, {
      sequence: message.sequence,
      angle: message.angle,
      boosting: message.boosting,
    });
    if (!accepted) connection.send(JSON.stringify({ _tag: "error", code: "STALE_INPUT" }));
  }

  private startLoop(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.step(), 1000 / defaultGameConfig.tickRate);
  }

  private stopLoop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private step(): void {
    const events = this.controller.tick();
    this.accessAttemptLimiter.prune();
    this.tickCounter += 1;
    if (events.deaths.length > 0 || this.tickCounter % 2 === 0) {
      this.broadcast(JSON.stringify({ _tag: "snapshot", snapshot: this.controller.snapshot() }));
    }
  }
}
