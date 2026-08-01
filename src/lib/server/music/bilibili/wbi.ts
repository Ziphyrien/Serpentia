import { createHash } from "node:crypto";
import { Schema } from "effect";
import { BilibiliNavResponse } from "./contracts";
import type { BilibiliApiClient } from "./client";
import { bilibiliError, isBilibiliError } from "./errors";

// WBI permutation is part of Bilibili's public request signing algorithm.
// Cross-checked against bbplayer (MIT): https://github.com/bbplayer-app/bbplayer
const MIXIN_KEY_ORDER = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];
const KEY_TTL_MILLISECONDS = 12 * 60 * 60 * 1_000;
const WBI_FILTER = /[!'()*]/gu;

export type WbiParameterValue = string | number;
export type WbiParameters = Readonly<Record<string, WbiParameterValue>>;

interface WbiKeys {
  readonly image: string;
  readonly sub: string;
  readonly expiresAt: number;
}

export class WbiSigner {
  private keys: WbiKeys | undefined;
  private pending: Promise<WbiKeys> | undefined;

  constructor(
    private readonly client: BilibiliApiClient,
    private readonly now: () => number = Date.now,
  ) {}

  async sign(parameters: WbiParameters, signal?: AbortSignal): Promise<string> {
    const keys = await this.getKeys(signal);
    return signWbi(parameters, keys.image, keys.sub, Math.floor(this.now() / 1_000));
  }

  invalidate(): void {
    this.keys = undefined;
  }

  async ready(signal?: AbortSignal): Promise<void> {
    await this.getKeys(signal);
  }

  private async getKeys(signal?: AbortSignal): Promise<WbiKeys> {
    if (this.keys !== undefined && this.keys.expiresAt > this.now()) return this.keys;
    if (this.pending === undefined) {
      const operation = this.loadKeys().then((keys) => {
        this.keys = keys;
        return keys;
      });
      this.pending = operation;
      const clearPending = (): void => {
        if (this.pending === operation) this.pending = undefined;
      };
      void operation.then(clearPending, clearPending);
    }
    return waitForCaller(this.pending, signal);
  }

  private async loadKeys(): Promise<WbiKeys> {
    try {
      const raw = await this.client.get("/x/web-interface/nav", undefined);
      const response = await Schema.decodeUnknownPromise(BilibiliNavResponse)(raw);
      if (response.code === -101 || response.data?.isLogin === false) {
        throw bilibiliError("AUTH_REQUIRED", "wbi.nav", "Bilibili Cookie is not logged in", {
          upstreamCode: response.code,
        });
      }
      if (response.code !== 0 || response.data?.wbi_img === undefined) {
        throw bilibiliError("PROTOCOL_ERROR", "wbi.nav", "Bilibili nav response has no WBI keys", {
          upstreamCode: response.code,
        });
      }
      const image = keyFromUrl(response.data.wbi_img.img_url);
      const sub = keyFromUrl(response.data.wbi_img.sub_url);
      if (image === undefined || sub === undefined) {
        throw bilibiliError("PROTOCOL_ERROR", "wbi.nav", "Bilibili returned invalid WBI key URLs");
      }
      return {
        image,
        sub,
        expiresAt: this.now() + KEY_TTL_MILLISECONDS,
      };
    } catch (cause) {
      if (isBilibiliError(cause)) throw cause;
      throw bilibiliError("PROTOCOL_ERROR", "wbi.nav", "Bilibili nav response failed validation");
    }
  }
}

export function signWbi(
  parameters: WbiParameters,
  imageKey: string,
  subKey: string,
  timestampSeconds: number,
): string {
  const source = imageKey + subKey;
  const mixinKey = MIXIN_KEY_ORDER.map((index) => source[index] ?? "").join("").slice(0, 32);
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(parameters)) {
    values.set(key, String(value).replace(WBI_FILTER, ""));
  }
  values.set("wts", String(timestampSeconds));
  const query = [...values.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const signature = createHash("md5").update(query + mixinKey).digest("hex");
  return `${query}&w_rid=${signature}`;
}

function waitForCaller<A>(operation: Promise<A>, signal?: AbortSignal): Promise<A> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    return Promise.reject(bilibiliError("TIMEOUT", "wbi.wait", "WBI signing was cancelled"));
  }
  return new Promise<A>((resolve, reject) => {
    const abort = (): void => {
      reject(bilibiliError("TIMEOUT", "wbi.wait", "WBI signing was cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}

function keyFromUrl(input: string): string | undefined {
  try {
    const filename = new URL(input).pathname.split("/").at(-1);
    if (filename === undefined) return undefined;
    const key = filename.split(".", 1)[0];
    return key && /^[0-9A-Za-z]+$/u.test(key) ? key : undefined;
  } catch {
    return undefined;
  }
}
