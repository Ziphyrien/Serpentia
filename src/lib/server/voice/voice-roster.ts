import type { VoiceParticipant } from "../../protocol/state";

export type { VoiceParticipant } from "../../protocol/state";

/** Active voice listeners; microphone publication is independent membership metadata. */
export class VoiceRoster {
  private readonly participants = new Map<string, VoiceParticipant>();

  upsert(playerId: string, nickname: string, microphoneEnabled: boolean, muted: boolean): boolean {
    const participant: VoiceParticipant = {
      playerId,
      nickname,
      microphoneEnabled,
      muted: !microphoneEnabled || muted,
    };
    const previous = this.participants.get(playerId);
    if (
      previous?.nickname === participant.nickname &&
      previous.microphoneEnabled === participant.microphoneEnabled &&
      previous.muted === participant.muted
    ) {
      return false;
    }
    this.participants.set(playerId, participant);
    return true;
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
