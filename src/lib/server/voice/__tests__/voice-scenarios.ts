import { VoiceRoster } from "../voice-roster";

export interface VoiceScenario {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export const voiceScenarios: ReadonlyArray<VoiceScenario> = [
  {
    name: "voice roster follows authenticated room membership and mute state",
    run: () => {
      const roster = new VoiceRoster();
      roster.join("friend-b", "Beta");
      roster.join("friend-a", "Alpha");
      requireCondition(roster.snapshot().every((participant) => participant.muted), "microphone was not private by default");
      requireCondition(roster.setMuted("friend-a", false), "member could not unmute");
      requireCondition(!roster.setMuted("intruder", false), "unknown player changed voice state");
      const snapshot = roster.snapshot();
      requireCondition(snapshot[0].playerId === "friend-a" && !snapshot[0].muted, "voice roster was inconsistent");
      requireCondition(roster.leave("friend-a"), "leaving member remained in voice roster");
    },
  },
];
