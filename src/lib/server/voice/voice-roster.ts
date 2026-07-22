import type { VoiceParticipant } from "../../protocol/state";

export type { VoiceParticipant } from "../../protocol/state";

export class VoiceRoster {
  private readonly participants = new Map<string, VoiceParticipant>();

  join(playerId: string, nickname: string): void {
    const current = this.participants.get(playerId);
    this.participants.set(playerId, {
      playerId,
      nickname,
      muted: current?.muted ?? true,
    });
  }

  leave(playerId: string): boolean {
    return this.participants.delete(playerId);
  }

  setMuted(playerId: string, muted: boolean): boolean {
    const participant = this.participants.get(playerId);
    if (participant === undefined) return false;
    this.participants.set(playerId, { ...participant, muted });
    return true;
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
