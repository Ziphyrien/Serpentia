import {
  GAME_PROTOCOL_VERSION,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_INPUT_MESSAGES_PER_SECOND,
  MAX_TOTAL_MESSAGES_PER_SECOND,
  MAX_VOICE_SIGNALS_PER_SECOND,
  type BackendDescriptor,
  type RoomMetadata,
} from "../../protocol/game";
import { defaultGameConfig } from "../game/config";
import { INPUT_LAG_TOLERANCE_SECONDS, INPUT_LEAD_TOLERANCE_SECONDS } from "./room-controller";

export const SNAPSHOT_RATE = 10;
export const RECONNECT_GRACE_SECONDS = 5;
export const RECONNECT_GRACE_TICKS = defaultGameConfig.tickRate * RECONNECT_GRACE_SECONDS;

export const ROOM_METADATA: RoomMetadata = Object.freeze({
  protocolVersion: GAME_PROTOCOL_VERSION,
  roomId: "friends",
  tickRate: defaultGameConfig.tickRate,
  snapshotRate: SNAPSHOT_RATE,
  reconnectGraceTicks: RECONNECT_GRACE_TICKS,
  voiceMode: "p2p",
  iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
  rules: {
    arenaHalfSize: defaultGameConfig.arenaHalfSize,
    baseSpeed: defaultGameConfig.baseSpeed,
    boostSpeed: defaultGameConfig.boostSpeed,
    turnRate: defaultGameConfig.turnRate,
    initialLength: defaultGameConfig.initialLength,
    minimumLength: defaultGameConfig.minimumLength,
    boostMinimumLength: defaultGameConfig.boostMinimumLength,
    boostDrainPerSecond: defaultGameConfig.boostDrainPerSecond,
    foodRadius: defaultGameConfig.foodRadius,
    respawnDelayTicks: defaultGameConfig.respawnDelayTicks,
    respawnInvulnerabilityTicks: defaultGameConfig.respawnInvulnerabilityTicks,
  },
  limits: {
    maxMessageBytes: MAX_CLIENT_MESSAGE_BYTES,
    maxInputMessagesPerSecond: MAX_INPUT_MESSAGES_PER_SECOND,
    maxVoiceSignalsPerSecond: MAX_VOICE_SIGNALS_PER_SECOND,
    maxTotalMessagesPerSecond: MAX_TOTAL_MESSAGES_PER_SECOND,
    maxInputLagTicks: defaultGameConfig.tickRate * INPUT_LAG_TOLERANCE_SECONDS,
    maxInputLeadTicks: defaultGameConfig.tickRate * INPUT_LEAD_TOLERANCE_SECONDS,
  },
});

export const BACKEND_DESCRIPTOR: BackendDescriptor = Object.freeze({
  ...ROOM_METADATA,
  sessionPath: "/api/session",
  turnCredentialsPath: "/api/turn-credentials",
  websocketPath: "/api/parties/game-room/friends",
});
