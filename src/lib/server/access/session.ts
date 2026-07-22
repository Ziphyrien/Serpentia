import { Schema } from "effect";

export const SESSION_COOKIE_NAME = "serpentia_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export class SessionClaims extends Schema.Class<SessionClaims>("SessionClaims")({
  playerId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  nickname: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24)),
  expiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  const payload = encodeBytes(new Uint8Array(utf8(JSON.stringify(claims))));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await importHmacKey(secret, ["sign"]), utf8(payload)),
  );
  return `${payload}.${encodeBytes(signature)}`;
}

export async function verifySession(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<SessionClaims | undefined> {
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return undefined;

  try {
    const payload = token.slice(0, separator);
    const signature = decodeBytes(token.slice(separator + 1));
    const valid = await crypto.subtle.verify(
      "HMAC",
      await importHmacKey(secret, ["verify"]),
      toArrayBuffer(signature),
      utf8(payload),
    );
    if (!valid) return undefined;

    const decodedText = new TextDecoder().decode(decodeBytes(payload));
    const raw: unknown = JSON.parse(decodedText);
    const claims = await Schema.decodeUnknownPromise(SessionClaims)(raw);
    return claims.expiresAt > now ? claims : undefined;
  } catch {
    return undefined;
  }
}

function utf8(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  return toArrayBuffer(encoded);
}

async function importHmacKey(secret: string, usages: ReadonlyArray<KeyUsage>): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
