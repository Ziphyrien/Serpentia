const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_LENGTH = 12;
const RAW_KEY_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;

export function normalizeAccessKey(input: string): string | undefined {
  const normalized = input.replaceAll("-", "").replaceAll(" ", "").toUpperCase();
  return RAW_KEY_PATTERN.test(normalized) ? normalized : undefined;
}

export function formatAccessKey(normalized: string): string | undefined {
  if (!RAW_KEY_PATTERN.test(normalized)) return undefined;
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}`;
}

export function generateAccessKey(entropy: Uint8Array = secureEntropy()): string {
  if (entropy.byteLength < 8) throw new Error("Access key generation requires at least 64 bits");

  let buffer = 0;
  let bitCount = 0;
  let result = "";
  for (const byte of entropy) {
    buffer = buffer * 256 + byte;
    bitCount += 8;
    while (bitCount >= 5 && result.length < KEY_LENGTH) {
      bitCount -= 5;
      const divisor = 2 ** bitCount;
      const index = Math.floor(buffer / divisor) & 31;
      result += CROCKFORD_ALPHABET[index];
      buffer %= divisor;
    }
    if (result.length === KEY_LENGTH) break;
  }

  const formatted = formatAccessKey(result);
  if (formatted === undefined) throw new Error("Generated access key is invalid");
  return formatted;
}

export async function hashAccessKey(input: string): Promise<string | undefined> {
  const normalized = normalizeAccessKey(input);
  if (normalized === undefined) return undefined;
  const bytes = new TextEncoder().encode(normalized);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return toHex(digest);
}

export async function identifyAccessKey(
  input: string,
  playerIdByHash: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  const hash = await hashAccessKey(input);
  return hash === undefined ? undefined : playerIdByHash.get(hash);
}

function secureEntropy(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(8));
}

function toHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}
