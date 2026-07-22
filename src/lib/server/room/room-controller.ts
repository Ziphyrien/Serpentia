import type { GameSnapshot, PlayerInput, TickEvents } from "../game/model";
import { GameEngine } from "../game/engine";

export const INPUT_LAG_TOLERANCE_SECONDS = 30;
export const INPUT_LEAD_TOLERANCE_SECONDS = 2;

export interface PlayerIdentity {
  readonly playerId: string;
  readonly nickname: string;
}

export interface RoomPlayerInput extends Omit<PlayerInput, "playerId"> {
  readonly clientTick: number;
}

export interface JoinAccepted {
  readonly _tag: "Accepted";
  readonly replacedConnectionId: string | undefined;
  readonly resumed: boolean;
  readonly snapshot: GameSnapshot;
}

export interface JoinRejected {
  readonly _tag: "Rejected";
  readonly reason: "NICKNAME_IN_USE";
}

export type JoinResult = JoinAccepted | JoinRejected;

export interface RoomTickResult {
  readonly events: TickEvents;
  readonly expiredPlayerIds: ReadonlyArray<string>;
}

export class RoomController {
  private readonly playerByConnection = new Map<string, string>();
  private readonly connectionByPlayer = new Map<string, string>();
  private readonly nicknameByPlayer = new Map<string, string>();
  private readonly disconnectDeadlineByPlayer = new Map<string, number>();
  readonly reconnectGraceTicks: number;

  constructor(
    private readonly engine: GameEngine,
    reconnectGraceTicks = engine.config.tickRate * 5,
  ) {
    this.reconnectGraceTicks = Math.max(0, Math.floor(reconnectGraceTicks));
  }

  get connectionCount(): number {
    return this.playerByConnection.size;
  }

  get currentTick(): number {
    return this.engine.tick;
  }

  get shouldRun(): boolean {
    return this.connectionByPlayer.size > 0 || this.disconnectDeadlineByPlayer.size > 0;
  }

  join(connectionId: string, identity: PlayerIdentity): JoinResult {
    const nicknameKey = canonicalNickname(identity.nickname);
    for (const [playerId, nickname] of this.nicknameByPlayer) {
      if (playerId !== identity.playerId && canonicalNickname(nickname) === nicknameKey) {
        return { _tag: "Rejected", reason: "NICKNAME_IN_USE" };
      }
    }

    const replacedConnectionId = this.connectionByPlayer.get(identity.playerId);
    if (replacedConnectionId !== undefined) this.playerByConnection.delete(replacedConnectionId);

    this.playerByConnection.set(connectionId, identity.playerId);
    this.connectionByPlayer.set(identity.playerId, connectionId);
    this.nicknameByPlayer.set(identity.playerId, identity.nickname);
    this.disconnectDeadlineByPlayer.delete(identity.playerId);

    const added = this.engine.addSnake(identity.playerId, identity.nickname);
    if (!added) this.engine.renameSnake(identity.playerId, identity.nickname);

    return {
      _tag: "Accepted",
      replacedConnectionId,
      resumed: !added,
      snapshot: this.engine.snapshot(),
    };
  }

  leave(connectionId: string): boolean {
    const playerId = this.playerByConnection.get(connectionId);
    if (playerId === undefined) return false;
    this.playerByConnection.delete(connectionId);

    if (this.connectionByPlayer.get(playerId) !== connectionId) return false;
    this.connectionByPlayer.delete(playerId);
    this.engine.suspendSnake(playerId);
    this.disconnectDeadlineByPlayer.set(playerId, this.engine.tick + this.reconnectGraceTicks);
    return true;
  }

  applyInput(connectionId: string, input: RoomPlayerInput): boolean {
    const playerId = this.playerByConnection.get(connectionId);
    if (playerId === undefined || this.connectionByPlayer.get(playerId) !== connectionId) {
      return false;
    }
    const maximumLag = this.engine.config.tickRate * INPUT_LAG_TOLERANCE_SECONDS;
    const maximumLead = this.engine.config.tickRate * INPUT_LEAD_TOLERANCE_SECONDS;
    if (
      input.clientTick < Math.max(0, this.engine.tick - maximumLag) ||
      input.clientTick > this.engine.tick + maximumLead
    ) {
      return false;
    }
    return this.engine.applyInput({
      playerId,
      sequence: input.sequence,
      angle: input.angle,
      boosting: input.boosting,
    });
  }

  connectionIdForPlayer(playerId: string): string | undefined {
    return this.connectionByPlayer.get(playerId);
  }

  isCurrentConnection(connectionId: string, playerId: string): boolean {
    return this.connectionByPlayer.get(playerId) === connectionId;
  }

  tick(): RoomTickResult {
    const events = this.engine.step();
    const expiredPlayerIds = this.expireDisconnectedPlayers();
    return { events, expiredPlayerIds };
  }

  snapshot(): GameSnapshot {
    return this.engine.snapshot();
  }

  private expireDisconnectedPlayers(): ReadonlyArray<string> {
    const expiredPlayerIds: Array<string> = [];
    for (const [playerId, deadline] of this.disconnectDeadlineByPlayer) {
      if (deadline <= this.engine.tick) expiredPlayerIds.push(playerId);
    }
    expiredPlayerIds.sort((left, right) => left.localeCompare(right));

    for (const playerId of expiredPlayerIds) {
      this.disconnectDeadlineByPlayer.delete(playerId);
      this.nicknameByPlayer.delete(playerId);
      this.engine.removeSnake(playerId);
    }
    return expiredPlayerIds;
  }
}

function canonicalNickname(nickname: string): string {
  return nickname.normalize("NFKC").toLowerCase();
}
