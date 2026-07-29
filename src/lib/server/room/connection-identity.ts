import { DEFAULT_SKIN_ID, isInternalSkinId } from "../../game/internal-skins";
import type { PlayerIdentity } from "./room-controller";

export interface ConnectionIdentity extends PlayerIdentity {
  readonly sessionExpiresAt: number;
}

/** 皮肤 ID 必须存在于官方清单，否则回落到默认皮肤。 */
export function normalizeSkinId(input: unknown): number {
  return isInternalSkinId(input) ? input : DEFAULT_SKIN_ID;
}

export function normalizeNickname(input: string): string | undefined {
  const nickname = input.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const characterCount = Array.from(nickname).length;
  if (characterCount === 0 || characterCount > 24) return undefined;
  if (containsControlCharacter(nickname)) return undefined;
  return nickname;
}

function containsControlCharacter(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}
