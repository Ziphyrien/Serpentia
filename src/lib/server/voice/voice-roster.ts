import type { VoiceParticipant } from "../../protocol/state";

export type { VoiceParticipant } from "../../protocol/state";

/** Active voice members only; ordinary game-room membership lives elsewhere. */
export class VoiceRoster {
  private readonly participants = new Map<string, VoiceParticipant>();

  join(playerId: string, nickname: string, muted: boolean): void {
    this.participants.set(playerId, { playerId, nickname, muted });
  }

  leave(playerId: string): boolean {
    return this.participants.delete(playerId);
  }

  has(playerId: string): boolean {
    return this.participants.has(playerId);
  }

  snapshot(): ReadonlyArray<VoiceParticipant> {
    return [...this.participants.values()].sort((left, right) =>
      left.playerId.localeCompare(right.playerId),
    );
  }
}
