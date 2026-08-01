import QRCode from "qrcode";
import { Schema } from "effect";
import {
  BilibiliCredentials,
  cookiePairsFromSetCookieHeaders,
  validateBilibiliRefreshToken,
} from "../src/lib/server/music/bilibili/credentials";
import { writeBilibiliEnvironmentFile } from "../src/lib/server/music/bilibili/env-file";

const LOGIN_TIMEOUT_MILLISECONDS = 180_000;
const POLL_INTERVAL_MILLISECONDS = 2_000;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const QrGenerateResponse = Schema.Struct({
  code: Schema.Int,
  message: Schema.optionalKey(Schema.String),
  data: Schema.Struct({
    url: Schema.String,
    qrcode_key: Schema.String,
  }),
});

const QrPollResponse = Schema.Struct({
  code: Schema.Int,
  message: Schema.optionalKey(Schema.String),
  data: Schema.Struct({
    url: Schema.String,
    refresh_token: Schema.String,
    timestamp: Schema.Int,
    code: Schema.Int,
    message: Schema.String,
  }),
});

const NavResponse = Schema.Struct({
  code: Schema.Int,
  data: Schema.Struct({
    isLogin: Schema.Boolean,
  }),
});

interface LoginSession {
  readonly cookie: string;
  readonly refreshToken: string;
}

async function main(): Promise<void> {
  const environmentFile = parseEnvironmentFile(process.argv.slice(2));
  const generatedResponse = await requestJson(
    "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
  );
  const generated = await decodeResponse(
    Schema.decodeUnknownPromise(QrGenerateResponse),
    generatedResponse.body,
    "Bilibili returned an invalid QR generation response",
  );
  if (generated.code !== 0) throw new Error("Bilibili refused to generate a login QR code");

  console.log("请使用哔哩哔哩手机客户端扫描并确认登录：\n");
  console.log(
    await QRCode.toString(generated.data.url, {
      type: "terminal",
      small: true,
      errorCorrectionLevel: "M",
    }),
  );
  console.log("二维码将在 180 秒后失效。凭据不会显示在终端。\n");

  const session = await pollLogin(generated.data.qrcode_key);
  await verifySession(session.cookie);
  await writeBilibiliEnvironmentFile(environmentFile, session);
  console.log(`登录成功，已安全写入 ${environmentFile}`);
  console.log("已更新 BILIBILI_COOKIE 与 BILIBILI_REFRESH_TOKEN；请重启服务加载初始值。");
}

async function pollLogin(qrcodeKey: string): Promise<LoginSession> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MILLISECONDS;
  let confirmedScan = false;
  while (Date.now() < deadline) {
    const url = new URL(
      "/x/passport-login/web/qrcode/poll",
      "https://passport.bilibili.com",
    );
    url.searchParams.set("qrcode_key", qrcodeKey);
    const polledResponse = await requestJson(url);
    const polled = await decodeResponse(
      Schema.decodeUnknownPromise(QrPollResponse),
      polledResponse.body,
      "Bilibili returned an invalid QR polling response",
    );
    if (polled.code !== 0) throw new Error("Bilibili QR login request failed");

    if (polled.data.code === 0) {
      const cookiePairs = loginCookiePairs(
        polledResponse.response.headers,
        polled.data.url,
      );
      const cookie = [...cookiePairs]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
      const credentials = BilibiliCredentials.fromEnvironment(cookie);
      if (!credentials.cookieValue("bili_jct")) {
        throw new Error("Bilibili login response did not contain bili_jct");
      }
      return {
        cookie: credentials.headerValue(),
        refreshToken: validateBilibiliRefreshToken(polled.data.refresh_token),
      };
    }
    if (polled.data.code === 86_038) throw new Error("二维码已失效，请重新运行脚本");
    if (polled.data.code === 86_090 && !confirmedScan) {
      confirmedScan = true;
      console.log("已扫码，请在手机客户端确认登录……");
    } else if (polled.data.code !== 86_101 && polled.data.code !== 86_090) {
      throw new Error(`无法完成扫码登录（状态码 ${polled.data.code}）`);
    }
    await delay(POLL_INTERVAL_MILLISECONDS);
  }
  throw new Error("二维码已超时，请重新运行脚本");
}

function loginCookiePairs(headers: Headers, redirect: string): ReadonlyMap<string, string> {
  const result = new Map(cookiePairsFromSetCookieHeaders(headers));
  try {
    const url = new URL(redirect);
    if (url.protocol !== "https:" || !/(^|\.)bili(?:bili|game)\.com$/u.test(url.hostname)) {
      return result;
    }
    for (const name of ["DedeUserID", "DedeUserID__ckMd5", "SESSDATA", "bili_jct", "sid"]) {
      const value = url.searchParams.get(name);
      if (value !== null && value.length > 0 && !result.has(name)) result.set(name, value);
    }
  } catch {
    // Set-Cookie is authoritative; the redirect URL is only a compatibility fallback.
  }
  return result;
}

async function verifySession(cookie: string): Promise<void> {
  const result = await requestJson("https://api.bilibili.com/x/web-interface/nav", {
    headers: { cookie },
  });
  const nav = await decodeResponse(
    Schema.decodeUnknownPromise(NavResponse),
    result.body,
    "Bilibili returned an invalid account response",
  );
  if (nav.code !== 0 || !nav.data.isLogin) {
    throw new Error("Bilibili returned cookies that are not authenticated");
  }
}

async function requestJson(
  input: string | URL,
  init: RequestInit = {},
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MILLISECONDS);
  try {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("referer", "https://www.bilibili.com/");
    headers.set("user-agent", USER_AGENT);
    const response = await fetch(input, {
      ...init,
      headers,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Bilibili returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 131_072) throw new Error("Bilibili returned an oversized response");
    const body: unknown = JSON.parse(text);
    return { response, body };
  } catch {
    if (controller.signal.aborted) throw new Error("Bilibili request timed out");
    throw new Error("Bilibili request failed");
  } finally {
    clearTimeout(timer);
  }
}

async function decodeResponse<A>(
  decoder: (input: unknown) => Promise<A>,
  input: unknown,
  message: string,
): Promise<A> {
  try {
    return await decoder(input);
  } catch {
    throw new Error(message);
  }
}

function parseEnvironmentFile(arguments_: ReadonlyArray<string>): string {
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    console.log("Usage: bun run bilibili:login -- [--env <path>]");
    process.exit(0);
  }
  if (arguments_.length === 0) return process.env.BILIBILI_ENV_FILE?.trim() || ".env";
  if (arguments_.length === 2 && arguments_[0] === "--env" && arguments_[1]) {
    return arguments_[1];
  }
  throw new Error("Usage: bun run bilibili:login -- [--env <path>]");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

void main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : "Unknown login failure";
  console.error(`扫码登录失败：${message}`);
  process.exitCode = 1;
});
