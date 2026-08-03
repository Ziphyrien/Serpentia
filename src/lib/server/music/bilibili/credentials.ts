import { containsAsciiControlCharacters } from "./ascii-control";
import { bilibiliError } from "./errors";

const MAX_COOKIE_LENGTH = 8_192;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const COOKIE_ATTRIBUTE_NAMES = new Set([
  "domain",
  "expires",
  "httponly",
  "max-age",
  "partitioned",
  "path",
  "priority",
  "samesite",
  "secure",
]);
const REFRESH_TOKEN_PATTERN = /^[0-9A-Za-z_-]{16,2048}$/u;
const AUTH_COOKIE_NAMES = new Set([
  "DedeUserID",
  "DedeUserID__ckMd5",
  "SESSDATA",
  "bili_jct",
  "sid",
]);

interface ParsedCookie {
  readonly header: string;
  readonly pairs: ReadonlyMap<string, string>;
}

export class BilibiliCredentials {
  #value: string;
  #pairs: ReadonlyMap<string, string>;

  private constructor(parsed: ParsedCookie) {
    this.#value = parsed.header;
    this.#pairs = parsed.pairs;
  }

  static fromEnvironment(value: string): BilibiliCredentials {
    return new BilibiliCredentials(parseCookieHeader(value));
  }

  headerValue(): string {
    return this.#value;
  }

  cookieValue(name: string): string | undefined {
    return this.#pairs.get(name);
  }

  mergedHeader(values: ReadonlyMap<string, string>): string {
    const merged = new Map(this.#pairs);
    for (const [name, value] of values) {
      if (!COOKIE_NAME.test(name) || COOKIE_ATTRIBUTE_NAMES.has(name.toLowerCase())) {
        throw bilibiliError("PROTOCOL_ERROR", "credentials.merge", "Invalid refreshed cookie name");
      }
      if (/[^\u0020-\u007e]/u.test(value) || value.includes(";")) {
        throw bilibiliError(
          "PROTOCOL_ERROR",
          "credentials.merge",
          "Invalid refreshed cookie value",
        );
      }
      merged.set(name, value);
    }
    return serializeCookiePairs(merged);
  }

  replace(value: string): void {
    const parsed = parseCookieHeader(value);
    this.#value = parsed.header;
    this.#pairs = parsed.pairs;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }
}

export function cookiePairsFromSetCookieHeaders(headers: Headers): ReadonlyMap<string, string> {
  const values = headers.getSetCookie();
  const candidates =
    values.length > 0
      ? values
      : (headers.get("set-cookie")?.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/u) ?? []);
  const result = new Map<string, string>();
  for (const candidate of candidates) {
    const pair = candidate.split(";", 1)[0]?.trim();
    const separator = pair?.indexOf("=") ?? -1;
    if (pair === undefined || separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (
      !COOKIE_NAME.test(name) ||
      COOKIE_ATTRIBUTE_NAMES.has(name.toLowerCase()) ||
      !AUTH_COOKIE_NAMES.has(name)
    ) {
      continue;
    }
    result.set(name, cookieValue);
  }
  return result;
}

export function validateBilibiliRefreshToken(value: string): string {
  const normalized = value.trim();
  if (!REFRESH_TOKEN_PATTERN.test(normalized)) {
    throw bilibiliError(
      "INVALID_CONFIG",
      "credentials.refreshToken",
      "BILIBILI_REFRESH_TOKEN must be a non-empty login refresh token",
    );
  }
  return normalized;
}

function parseCookieHeader(value: string): ParsedCookie {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_COOKIE_LENGTH ||
    containsAsciiControlCharacters(normalized)
  ) {
    throw bilibiliError(
      "INVALID_CONFIG",
      "BilibiliCredentials.fromEnvironment",
      "BILIBILI_COOKIE must be a single non-empty Cookie header value no longer than 8192 characters",
    );
  }

  const pairs = new Map<string, string>();
  for (const segment of normalized.split(";")) {
    const item = segment.trim();
    const separator = item.indexOf("=");
    if (separator <= 0) {
      throw bilibiliError(
        "INVALID_CONFIG",
        "BilibiliCredentials.fromEnvironment",
        "BILIBILI_COOKIE contains an invalid cookie pair",
      );
    }
    const name = item.slice(0, separator).trim();
    const cookieValue = item.slice(separator + 1).trim();
    if (
      !COOKIE_NAME.test(name) ||
      COOKIE_ATTRIBUTE_NAMES.has(name.toLowerCase()) ||
      pairs.has(name)
    ) {
      throw bilibiliError(
        "INVALID_CONFIG",
        "BilibiliCredentials.fromEnvironment",
        "BILIBILI_COOKIE contains an invalid or duplicate cookie name",
      );
    }
    pairs.set(name, cookieValue);
  }
  if (!pairs.get("SESSDATA")) {
    throw bilibiliError(
      "INVALID_CONFIG",
      "BilibiliCredentials.fromEnvironment",
      "BILIBILI_COOKIE must contain a non-empty SESSDATA cookie",
    );
  }
  return {
    header: serializeCookiePairs(pairs),
    pairs,
  };
}

function serializeCookiePairs(pairs: ReadonlyMap<string, string>): string {
  return [...pairs].map(([name, value]) => `${name}=${value}`).join("; ");
}
