import type { PlayerIdentity } from "./room-controller";

const PLAYER_ID_HEADER = "x-serpentia-player-id";
const NICKNAME_HEADER = "x-serpentia-nickname";

export function normalizeNickname(input: string): string | undefined {
  const nickname = input.trim();
  if (nickname.length === 0 || nickname.length > 24) return undefined;
  if (containsControlCharacter(nickname)) return undefined;
  return nickname;
}

export function readPlayerIdentity(request: Request): PlayerIdentity | undefined {
  const playerId = request.headers.get(PLAYER_ID_HEADER)?.trim();
  const nickname = normalizeNickname(request.headers.get(NICKNAME_HEADER) ?? "");
  if (playerId === undefined || nickname === undefined) return undefined;
  if (playerId.length === 0 || playerId.length > 64) return undefined;
  return { playerId, nickname };
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) return true;
  }
  return false;
}
