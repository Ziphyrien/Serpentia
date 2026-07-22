import type { PlayerIdentity } from "./room-controller";

const PLAYER_ID_HEADER = "x-serpentia-player-id";
const NICKNAME_HEADER = "x-serpentia-nickname";
const SESSION_EXPIRES_AT_HEADER = "x-serpentia-session-expires-at";
const PLAYER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export interface ConnectionIdentity extends PlayerIdentity {
  readonly sessionExpiresAt: number;
}

export function normalizeNickname(input: string): string | undefined {
  const nickname = input.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const characterCount = Array.from(nickname).length;
  if (characterCount === 0 || characterCount > 24) return undefined;
  if (containsControlCharacter(nickname)) return undefined;
  return nickname;
}

export function encodeNicknameHeader(nickname: string): string {
  return encodeURIComponent(nickname);
}

export function readPlayerIdentity(
  request: Request,
  now = Date.now(),
): ConnectionIdentity | undefined {
  const playerId = request.headers.get(PLAYER_ID_HEADER)?.trim();
  const encodedNickname = request.headers.get(NICKNAME_HEADER);
  const sessionExpiresAt = Number(request.headers.get(SESSION_EXPIRES_AT_HEADER));
  if (
    playerId === undefined ||
    !PLAYER_ID_PATTERN.test(playerId) ||
    encodedNickname === null ||
    !Number.isSafeInteger(sessionExpiresAt) ||
    sessionExpiresAt <= now
  ) {
    return undefined;
  }

  let decodedNickname: string;
  try {
    decodedNickname = decodeURIComponent(encodedNickname);
  } catch {
    return undefined;
  }
  const nickname = normalizeNickname(decodedNickname);
  return nickname === undefined ? undefined : { playerId, nickname, sessionExpiresAt };
}

function containsControlCharacter(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}
