import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { musicSourceError } from "./errors";

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 2_097_152;
const MAX_REDIRECTS = 5;
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "connection",
  "cookie",
  "forwarded",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);
const blockedAddresses = createBlockedAddresses();

export interface MusicHttpResponse {
  readonly response: {
    readonly statusCode: number;
    readonly statusMessage: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly bytes: number;
    readonly raw: Uint8Array;
    readonly body: unknown;
  };
  readonly body: unknown;
}

interface RequestOptions {
  readonly method: string;
  readonly timeout: number;
  readonly headers: Headers;
  readonly body: BodyInit | undefined;
}

export type MusicFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type MusicDnsLookup = (
  hostname: string,
) => Promise<ReadonlyArray<{ readonly address: string; readonly family: number }>>;

export class MusicOutboundHttp {
  constructor(
    private readonly fetcher: MusicFetch = globalThis.fetch,
    private readonly lookup: MusicDnsLookup = async (hostname) => {
      const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
      return addresses.map(({ address, family }) => ({ address, family }));
    },
  ) {}

  async request(
    url: string,
    rawOptions: unknown,
    signal?: AbortSignal,
  ): Promise<MusicHttpResponse> {
    const options = normalizeOptions(rawOptions);
    let target = await this.assertPublicUrl(url);
    let method = options.method;
    let body = options.body;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("HTTP request timed out")),
      options.timeout,
    );

    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        const response = await this.fetcher(target, {
          method,
          headers: options.headers,
          body: method === "GET" || method === "HEAD" ? undefined : body,
          redirect: "manual",
          signal: controller.signal,
        });
        if (isRedirect(response.status)) {
          if (redirects >= MAX_REDIRECTS) {
            throw musicSourceError("POLICY_DENIED", "Too many HTTP redirects");
          }
          const location = response.headers.get("location");
          if (location === null)
            throw musicSourceError("UPSTREAM_FAILED", "Redirect is missing Location");
          target = await this.assertPublicUrl(new URL(location, target).toString());
          if (
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) && method === "POST")
          ) {
            method = "GET";
            body = undefined;
          }
          continue;
        }

        const raw = await readBoundedResponse(response);
        const text = new TextDecoder().decode(raw);
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // LX exposes non-JSON responses as strings.
        }
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== "set-cookie") headers[key] = value;
        });
        const result = {
          statusCode: response.status,
          statusMessage: response.statusText,
          headers,
          bytes: raw.byteLength,
          raw,
          body: parsed,
        };
        return { response: result, body: parsed };
      }
      throw musicSourceError("POLICY_DENIED", "Too many HTTP redirects");
    } catch (cause) {
      if (cause instanceof Error && cause.name === "MusicSourceError") throw cause;
      if (controller.signal.aborted) throw musicSourceError("TIMEOUT", "HTTP request was aborted");
      throw musicSourceError("UPSTREAM_FAILED", messageOf(cause));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async assertPublicUrl(value: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw musicSourceError("POLICY_DENIED", "Invalid HTTP URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw musicSourceError("POLICY_DENIED", "Only HTTP and HTTPS URLs are allowed");
    }
    if (url.username !== "" || url.password !== "") {
      throw musicSourceError("POLICY_DENIED", "URL credentials are not allowed");
    }
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    if (port !== 80 && port !== 443) {
      throw musicSourceError("POLICY_DENIED", "Only ports 80 and 443 are allowed");
    }

    const hostname = stripBrackets(url.hostname).toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      throw musicSourceError("POLICY_DENIED", "Local addresses are not allowed");
    }
    const literalFamily = isIP(hostname);
    const addresses =
      literalFamily === 0
        ? await this.lookup(hostname)
        : [{ address: hostname, family: literalFamily }];
    if (
      addresses.length === 0 ||
      addresses.some(({ address, family }) => isBlocked(address, family))
    ) {
      throw musicSourceError("POLICY_DENIED", "Private or reserved addresses are not allowed");
    }
    return url;
  }
}

function normalizeOptions(value: unknown): RequestOptions {
  const options = isRecord(value) ? value : {};
  const method = typeof options.method === "string" ? options.method.toUpperCase() : "GET";
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) {
    throw musicSourceError("POLICY_DENIED", "Unsupported HTTP method");
  }
  const timeoutValue = typeof options.timeout === "number" ? options.timeout : 60_000;
  const timeout = Math.max(
    1,
    Math.min(60_000, Number.isFinite(timeoutValue) ? timeoutValue : 60_000),
  );
  const headers = normalizeHeaders(options.headers);
  const body = normalizeBody(options, headers);
  return { method, timeout, headers, body };
}

function normalizeHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (!isRecord(value)) return headers;
  for (const [key, raw] of Object.entries(value)) {
    const normalized = key.trim().toLowerCase();
    if (normalized === "" || FORBIDDEN_HEADERS.has(normalized)) continue;
    if (typeof raw === "string" || typeof raw === "number")
      headers.set(key, String(raw).slice(0, 8_192));
  }
  return headers;
}

function normalizeBody(options: Record<string, unknown>, headers: Headers): BodyInit | undefined {
  if (options.body !== undefined) return boundedBody(options.body, headers);
  if (isRecord(options.form)) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(options.form)) form.set(key, String(value));
    const encoded = form.toString();
    ensureRequestSize(new TextEncoder().encode(encoded).byteLength);
    headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return encoded;
  }
  if (isRecord(options.formData)) {
    const form = new FormData();
    for (const [key, value] of Object.entries(options.formData)) {
      if (typeof value === "string") form.set(key, value);
      else if (value instanceof Uint8Array) form.set(key, new Blob([copyArrayBuffer(value)]));
      else form.set(key, String(value));
    }
    return form;
  }
  return undefined;
}

function boundedBody(value: unknown, headers: Headers): BodyInit {
  if (typeof value === "string") {
    ensureRequestSize(new TextEncoder().encode(value).byteLength);
    return value;
  }
  if (value instanceof Uint8Array) {
    ensureRequestSize(value.byteLength);
    return copyArrayBuffer(value);
  }
  if (value instanceof ArrayBuffer) {
    ensureRequestSize(value.byteLength);
    return value;
  }
  const encoded = JSON.stringify(value);
  ensureRequestSize(new TextEncoder().encode(encoded).byteLength);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return encoded;
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw musicSourceError("POLICY_DENIED", "HTTP response is too large");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw musicSourceError("POLICY_DENIED", "HTTP response is too large");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(value.byteLength);
  new Uint8Array(output).set(value);
  return output;
}

function ensureRequestSize(size: number): void {
  if (size > MAX_REQUEST_BYTES)
    throw musicSourceError("POLICY_DENIED", "HTTP request is too large");
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function createBlockedAddresses(): BlockList {
  const list = new BlockList();
  const ipv4Subnets: ReadonlyArray<readonly [string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  for (const [network, prefix] of ipv4Subnets) {
    list.addSubnet(network, prefix, "ipv4");
  }
  list.addSubnet("::", 128, "ipv6");
  list.addSubnet("::1", 128, "ipv6");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  list.addSubnet("ff00::", 8, "ipv6");
  list.addSubnet("2001:db8::", 32, "ipv6");
  return list;
}

function isBlocked(address: string, family: number): boolean {
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) {
    const mapped = address.slice(address.lastIndexOf(":") + 1);
    return isIP(mapped) === 4 ? blockedAddresses.check(mapped, "ipv4") : true;
  }
  return blockedAddresses.check(address, family === 6 ? "ipv6" : "ipv4");
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "HTTP request failed";
}
