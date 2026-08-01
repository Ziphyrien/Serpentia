import { resolve } from "node:path";
import { Schema } from "effect";
import type { IceServer } from "../../protocol";
import { isSessionSigningSecretConfigured } from "../access/session";
import {
  BilibiliCredentials,
  validateBilibiliRefreshToken,
} from "../music/bilibili/credentials";
import { isCoturnConfigured, type CoturnConfig } from "../voice/coturn";

const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"];

export interface RuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly sessionSigningSecret: string;
  readonly publicIceServers: ReadonlyArray<IceServer>;
  readonly coturn: CoturnConfig | undefined;
  readonly trustProxy: boolean;
  readonly cookieSecure: boolean;
  readonly tlsCertFile: string | undefined;
  readonly tlsKeyFile: string | undefined;
  readonly bilibiliCookie: string;
  readonly bilibiliRefreshToken: string;
  readonly bilibiliEnvironmentFile: string;
}

export class RuntimeConfigError extends Schema.TaggedErrorClass<RuntimeConfigError>()(
  "RuntimeConfigError",
  { message: Schema.String },
) {}

/** 启动时一次性读取并验证 VPS 环境变量，配置错误直接阻止服务启动。 */
export function loadRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeConfig {
  const sessionSigningSecret = requireValue(environment, "SESSION_SIGNING_SECRET");
  const bilibiliCookie = requireValue(environment, "BILIBILI_COOKIE");
  const bilibiliRefreshToken = requireValue(environment, "BILIBILI_REFRESH_TOKEN");
  try {
    const credentials = BilibiliCredentials.fromEnvironment(bilibiliCookie);
    if (!credentials.cookieValue("bili_jct")) throw new Error("missing bili_jct");
    validateBilibiliRefreshToken(bilibiliRefreshToken);
  } catch {
    throw RuntimeConfigError.make({
      message:
        "BILIBILI_COOKIE must contain valid SESSDATA and bili_jct cookies, and BILIBILI_REFRESH_TOKEN must be valid",
    });
  }
  if (!isSessionSigningSecretConfigured(sessionSigningSecret)) {
    throw RuntimeConfigError.make({
      message: "SESSION_SIGNING_SECRET must contain at least 32 characters",
    });
  }

  const stunUrls = parseUrls(environment.STUN_URLS, DEFAULT_STUN_URLS, /^stuns?:/u, "STUN_URLS");
  const turnUrls = parseUrls(environment.TURN_URLS, [], /^turns?:/u, "TURN_URLS");
  const turnSharedSecret = environment.TURN_SHARED_SECRET?.trim() ?? "";

  let coturn: CoturnConfig | undefined;
  if (turnUrls.length > 0 || turnSharedSecret.length > 0) {
    coturn = { turnUrls, stunUrls, sharedSecret: turnSharedSecret };
    if (!isCoturnConfigured(coturn)) {
      throw RuntimeConfigError.make({
        message: "TURN_URLS and a TURN_SHARED_SECRET of at least 32 characters are both required",
      });
    }
  }

  const tlsCertFile = optionalValue(environment.TLS_CERT_FILE);
  const tlsKeyFile = optionalValue(environment.TLS_KEY_FILE);
  if ((tlsCertFile === undefined) !== (tlsKeyFile === undefined)) {
    throw RuntimeConfigError.make({
      message: "TLS_CERT_FILE and TLS_KEY_FILE must be configured together",
    });
  }

  return {
    host: environment.HOST?.trim() || "0.0.0.0",
    port: parsePort(environment.PORT),
    sessionSigningSecret,
    publicIceServers: stunUrls.length > 0 ? [{ urls: stunUrls }] : [],
    coturn,
    trustProxy: parseBoolean(environment.TRUST_PROXY, false),
    cookieSecure: parseBoolean(environment.COOKIE_SECURE, environment.NODE_ENV === "production"),
    tlsCertFile,
    tlsKeyFile,
    bilibiliCookie,
    bilibiliRefreshToken,
    bilibiliEnvironmentFile: resolve(optionalValue(environment.BILIBILI_ENV_FILE) ?? ".env"),
  };
}

function requireValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw RuntimeConfigError.make({ message: `${name} is required` });
  return value;
}

function optionalValue(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw RuntimeConfigError.make({ message: "PORT must be an integer between 1 and 65535" });
  }
  return port;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw RuntimeConfigError.make({ message: `Invalid boolean value: ${value}` });
}

function parseUrls(
  value: string | undefined,
  fallback: ReadonlyArray<string>,
  pattern: RegExp,
  name: string,
): Array<string> {
  const urls =
    value === undefined || value.trim() === ""
      ? [...fallback]
      : value
          .split(",")
          .map((url) => url.trim())
          .filter((url) => url.length > 0);
  if (!urls.every((url) => pattern.test(url))) {
    throw RuntimeConfigError.make({ message: `${name} contains an unsupported URL` });
  }
  return urls;
}
