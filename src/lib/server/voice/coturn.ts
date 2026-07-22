import { Schema } from "effect";
import type { IceServer, TurnCredentialsResponse } from "../../protocol";

export const TURN_CREDENTIAL_TTL_SECONDS = 6 * 60 * 60;
export const TURN_CREDENTIAL_REFRESH_MARGIN_SECONDS = 15 * 60;

const MINIMUM_SHARED_SECRET_LENGTH = 32;
const MAXIMUM_TURN_CREDENTIAL_TTL_SECONDS = 48 * 60 * 60;
const TURN_URL_PATTERN = /^turns?:/u;
const STUN_URL_PATTERN = /^stuns?:/u;

export interface CoturnConfig {
  readonly turnUrls: ReadonlyArray<string>;
  readonly stunUrls: ReadonlyArray<string>;
  readonly sharedSecret: string;
}

export interface CoturnCredentialOptions {
  readonly now?: number;
  readonly ttlSeconds?: number;
}

export class CoturnCredentialsError extends Schema.TaggedErrorClass<CoturnCredentialsError>()(
  "CoturnCredentialsError",
  {
    reason: Schema.Union([Schema.Literal("MISCONFIGURED"), Schema.Literal("SIGNING_FAILED")]),
  },
) {}

export function isCoturnConfigured(config: CoturnConfig): boolean {
  return (
    config.sharedSecret.length >= MINIMUM_SHARED_SECRET_LENGTH &&
    config.turnUrls.length > 0 &&
    config.turnUrls.every((url) => TURN_URL_PATTERN.test(url)) &&
    config.stunUrls.every((url) => STUN_URL_PATTERN.test(url))
  );
}

/**
 * 生成 coturn REST API 临时凭据。
 * coturn 需启用 use-auth-secret，并配置相同的 static-auth-secret。
 */
export async function createCoturnCredentials(
  config: CoturnConfig,
  playerId: string,
  options: CoturnCredentialOptions = {},
): Promise<TurnCredentialsResponse> {
  const ttlSeconds = options.ttlSeconds ?? TURN_CREDENTIAL_TTL_SECONDS;
  if (
    !isCoturnConfigured(config) ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= TURN_CREDENTIAL_REFRESH_MARGIN_SECONDS ||
    ttlSeconds > MAXIMUM_TURN_CREDENTIAL_TTL_SECONDS
  ) {
    throw CoturnCredentialsError.make({ reason: "MISCONFIGURED" });
  }

  const now = Math.floor(options.now ?? Date.now());
  const expiresAt = now + ttlSeconds * 1_000;
  const username = `${Math.floor(expiresAt / 1_000)}:${playerId}`;

  let credential: string;
  try {
    credential = await hmacSha1Base64(config.sharedSecret, username);
  } catch {
    throw CoturnCredentialsError.make({ reason: "SIGNING_FAILED" });
  }

  const iceServers: Array<IceServer> = [];
  if (config.stunUrls.length > 0) iceServers.push({ urls: [...config.stunUrls] });
  iceServers.push({
    urls: [...config.turnUrls],
    username,
    credential,
  });

  return {
    iceServers,
    expiresAt,
    refreshAfter: expiresAt - TURN_CREDENTIAL_REFRESH_MARGIN_SECONDS * 1_000,
  };
}

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary);
}
