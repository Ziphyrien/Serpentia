import type { GameSnapshot, PlayerInput, TickEvents } from "../game/model";
import { GameEngine } from "../game/engine";

export interface PlayerIdentity {
  readonly playerId: string;
  readonly nickname: string;
}

export interface JoinResult {
  readonly replacedConnectionId: string | undefined;
  readonly snapshot: GameSnapshot;
}

export class RoomController {
  private readonly playerByConnection = new Map<string, string>();
  private readonly connectionByPlayer = new Map<string, string>();

  constructor(private readonly engine: GameEngine) {}

  get connectionCount(): number {
    return this.playerByConnection.size;
  }

  join(connectionId: string, identity: PlayerIdentity): JoinResult {
    const replacedConnectionId = this.connectionByPlayer.get(identity.playerId);
    if (replacedConnectionId !== undefined) this.playerByConnection.delete(replacedConnectionId);

    this.playerByConnection.set(connectionId, identity.playerId);
    this.connectionByPlayer.set(identity.playerId, connectionId);

    if (!this.engine.addSnake(identity.playerId, identity.nickname)) {
      this.engine.renameSnake(identity.playerId, identity.nickname);
    }

    return { replacedConnectionId, snapshot: this.engine.snapshot() };
  }

  leave(connectionId: string): boolean {
    const playerId = this.playerByConnection.get(connectionId);
    if (playerId === undefined) return false;
    this.playerByConnection.delete(connectionId);

    if (this.connectionByPlayer.get(playerId) !== connectionId) return false;
    this.connectionByPlayer.delete(playerId);
    this.engine.removeSnake(playerId);
    return true;
  }

  applyInput(connectionId: string, input: Omit<PlayerInput, "playerId">): boolean {
    const playerId = this.playerByConnection.get(connectionId);
    if (playerId === undefined) return false;
    return this.engine.applyInput({ playerId, ...input });
  }

  tick(): TickEvents {
    return this.engine.step();
  }

  snapshot(): GameSnapshot {
    return this.engine.snapshot();
  }
}
