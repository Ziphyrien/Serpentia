import { constants, publicEncrypt } from "node:crypto";
import { Schema } from "effect";
import { BILIBILI_MEDIA_HEADERS, type BilibiliFetch } from "./client";
import {
  BilibiliCredentials,
  cookiePairsFromSetCookieHeaders,
  validateBilibiliRefreshToken,
} from "./credentials";
import { writeBilibiliEnvironmentFile } from "./env-file";
import { bilibiliError, isBilibiliError } from "./errors";

const REFRESH_CHECK_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1_000;
const REFRESH_RETRY_INTERVAL_MILLISECONDS = 60 * 60 * 1_000;
const INITIAL_REFRESH_DELAY_MILLISECONDS = 5_000;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAX_RESPONSE_BYTES = 131_072;
const REFRESH_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;

const CookieInfoResponse = Schema.Struct({
  code: Schema.Int,
  message: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        refresh: Schema.Boolean,
        timestamp: Schema.Int.check(Schema.isGreaterThan(0)),
      }),
    ),
  ),
});

const CookieRefreshResponse = Schema.Struct({
  code: Schema.Int,
  message: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        status: Schema.optionalKey(Schema.Int),
        refresh_token: Schema.String,
      }),
    ),
  ),
});

const CookieConfirmResponse = Schema.Struct({
  code: Schema.Int,
  message: Schema.optionalKey(Schema.String),
});

interface RefreshHttpResponse {
  readonly response: Response;
  readonly body: string;
}

export interface BilibiliSessionRefresherOptions {
  readonly refreshToken: string;
  readonly environmentFile: string;
  readonly fetch?: BilibiliFetch;
  readonly now?: () => number;
}

export class BilibiliSessionRefresher {
  private refreshToken: string;
  private checkedAt = 0;
  private pending: Promise<void> | undefined;
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly fetcher: BilibiliFetch;
  private readonly now: () => number;
  private readonly environmentFile: string;

  constructor(
    private readonly credentials: BilibiliCredentials,
    options: BilibiliSessionRefresherOptions,
  ) {
    this.refreshToken = validateBilibiliRefreshToken(options.refreshToken);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.environmentFile = options.environmentFile;
    if (!this.credentials.cookieValue("bili_jct")) {
      throw bilibiliError(
        "INVALID_CONFIG",
        "refresh.initialize",
        "BILIBILI_COOKIE must contain bili_jct when automatic refresh is enabled",
      );
    }
  }

  start(): void {
    if (this.disposed || this.scheduled !== undefined) return;
    this.schedule(INITIAL_REFRESH_DELAY_MILLISECONDS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled !== undefined) clearTimeout(this.scheduled);
    this.scheduled = undefined;
  }

  async ensureFresh(signal?: AbortSignal): Promise<void> {
    const elapsed = this.now() - this.checkedAt;
    if (
      this.checkedAt > 0 &&
      elapsed >= 0 &&
      elapsed < REFRESH_CHECK_INTERVAL_MILLISECONDS
    ) {
      return;
    }
    if (this.pending === undefined) {
      const operation = this.checkAndRefresh();
      this.pending = operation;
      const clear = (): void => {
        if (this.pending === operation) this.pending = undefined;
      };
      void operation.then(clear, clear);
    }
    return waitForCaller(this.pending, signal);
  }

  private schedule(delay: number): void {
    if (this.disposed) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      void this.ensureFresh().then(
        () => this.schedule(REFRESH_CHECK_INTERVAL_MILLISECONDS),
        (cause: unknown) => {
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "bilibili_credentials_refresh_failed",
              reason: isBilibiliError(cause) ? cause.reason : "UNKNOWN",
            }),
          );
          this.schedule(REFRESH_RETRY_INTERVAL_MILLISECONDS);
        },
      );
    }, delay);
    this.scheduled.unref?.();
  }

  private async checkAndRefresh(): Promise<void> {
    const csrf = this.requireCsrf();
    const checkUrl = new URL(
      "/x/passport-login/web/cookie/info",
      "https://passport.bilibili.com",
    );
    checkUrl.searchParams.set("csrf", csrf);
    const checkRaw = await this.request(checkUrl, { method: "GET" });
    const check = await decode(
      Schema.decodeUnknownPromise(CookieInfoResponse),
      checkRaw.body,
      "refresh.check",
    );
    assertRefreshCode(check.code, "refresh.check", check.message);
    if (check.data === undefined || check.data === null) {
      throw bilibiliError("PROTOCOL_ERROR", "refresh.check", "Cookie refresh check returned no data");
    }
    if (!check.data.refresh) {
      this.checkedAt = this.now();
      return;
    }

    const correspondPath = publicEncrypt(
      {
        key: REFRESH_PUBLIC_KEY,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(`refresh_${check.data.timestamp}`, "utf8"),
    ).toString("hex");
    const correspond = await this.request(
      new URL(`/correspond/1/${correspondPath}`, "https://www.bilibili.com"),
      { method: "GET" },
    );
    const refreshCsrf = refreshCsrfFromHtml(correspond.body);
    const oldRefreshToken = this.refreshToken;
    const refreshForm = new URLSearchParams({
      csrf,
      refresh_csrf: refreshCsrf,
      source: "main_web",
      refresh_token: oldRefreshToken,
    });
    const refreshedRaw = await this.request(
      new URL("/x/passport-login/web/cookie/refresh", "https://passport.bilibili.com"),
      {
        method: "POST",
        body: refreshForm,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
    );
    const refreshed = await decode(
      Schema.decodeUnknownPromise(CookieRefreshResponse),
      refreshedRaw.body,
      "refresh.rotate",
    );
    assertRefreshCode(refreshed.code, "refresh.rotate", refreshed.message);
    if (
      refreshed.data === undefined ||
      refreshed.data === null ||
      (refreshed.data.status !== undefined && refreshed.data.status !== 0)
    ) {
      throw bilibiliError("PROTOCOL_ERROR", "refresh.rotate", "Cookie refresh returned no data");
    }

    const updatedPairs = cookiePairsFromSetCookieHeaders(refreshedRaw.response.headers);
    if (!updatedPairs.get("SESSDATA") || !updatedPairs.get("bili_jct")) {
      throw bilibiliError(
        "PROTOCOL_ERROR",
        "refresh.rotate",
        "Cookie refresh did not return a complete session",
      );
    }
    const nextCookie = this.credentials.mergedHeader(updatedPairs);
    BilibiliCredentials.fromEnvironment(nextCookie);
    const nextRefreshToken = validateBilibiliRefreshToken(refreshed.data.refresh_token);

    await writeBilibiliEnvironmentFile(this.environmentFile, {
      cookie: nextCookie,
      refreshToken: nextRefreshToken,
    });
    this.credentials.replace(nextCookie);
    this.refreshToken = nextRefreshToken;

    const nextCsrf = this.requireCsrf();
    const confirmForm = new URLSearchParams({
      csrf: nextCsrf,
      refresh_token: oldRefreshToken,
    });
    const confirmedRaw = await this.request(
      new URL("/x/passport-login/web/confirm/refresh", "https://passport.bilibili.com"),
      {
        method: "POST",
        body: confirmForm,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
    );
    const confirmed = await decode(
      Schema.decodeUnknownPromise(CookieConfirmResponse),
      confirmedRaw.body,
      "refresh.confirm",
    );
    assertRefreshCode(confirmed.code, "refresh.confirm", confirmed.message);
    this.checkedAt = this.now();
    console.info(JSON.stringify({ level: "info", event: "bilibili_credentials_refreshed" }));
  }

  private requireCsrf(): string {
    const value = this.credentials.cookieValue("bili_jct");
    if (!value) {
      throw bilibiliError("AUTH_REQUIRED", "refresh.csrf", "Bilibili CSRF cookie is unavailable");
    }
    return value;
  }

  private async request(url: URL, init: RequestInit): Promise<RefreshHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Bilibili credential request timed out")),
      REQUEST_TIMEOUT_MILLISECONDS,
    );
    try {
      const headers = new Headers(BILIBILI_MEDIA_HEADERS);
      headers.set("accept", "application/json, text/html;q=0.9");
      headers.set("cookie", this.credentials.headerValue());
      headers.set("origin", "https://www.bilibili.com");
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
      const response = await this.fetcher(url, {
        ...init,
        headers,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw bilibiliError("UPSTREAM_FAILED", "refresh.http", "Bilibili refresh endpoint failed", {
          status: response.status,
        });
      }
      const body = await readBoundedText(response);
      return { response, body };
    } catch (cause) {
      if (isBilibiliError(cause)) throw cause;
      if (controller.signal.aborted) {
        throw bilibiliError("TIMEOUT", "refresh.http", "Bilibili credential request timed out");
      }
      throw bilibiliError("UPSTREAM_FAILED", "refresh.http", "Bilibili credential request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

async function decode<A>(
  decoder: (input: unknown) => Promise<A>,
  body: string,
  operation: string,
): Promise<A> {
  try {
    const raw: unknown = JSON.parse(body);
    return await decoder(raw);
  } catch {
    throw bilibiliError("PROTOCOL_ERROR", operation, "Bilibili refresh response is invalid");
  }
}

function assertRefreshCode(code: number, operation: string, message = ""): void {
  if (code === 0) return;
  if (code === -101 || code === -111 || code === 86_095) {
    throw bilibiliError("AUTH_REQUIRED", operation, "Bilibili credentials cannot be refreshed", {
      upstreamCode: code,
    });
  }
  throw bilibiliError("UPSTREAM_FAILED", operation, message || "Bilibili refresh failed", {
    upstreamCode: code,
  });
}

function refreshCsrfFromHtml(html: string): string {
  const match = /<div\s+id=["']1-name["'][^>]*>\s*([0-9a-f]{32})\s*<\/div>/iu.exec(html);
  if (match?.[1] === undefined) {
    throw bilibiliError("PROTOCOL_ERROR", "refresh.correspond", "Refresh CSRF token is missing");
  }
  return match[1];
}

async function readBoundedText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw bilibiliError("PROTOCOL_ERROR", "refresh.http", "Refresh response is too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function waitForCaller(operation: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    return Promise.reject(bilibiliError("TIMEOUT", "refresh.wait", "Credential refresh was cancelled"));
  }
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => reject(
      bilibiliError("TIMEOUT", "refresh.wait", "Credential refresh was cancelled"),
    );
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}
