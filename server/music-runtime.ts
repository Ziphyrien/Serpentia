import { Buffer } from "node:buffer";
import { constants, createCipheriv, createHash, publicEncrypt, randomBytes } from "node:crypto";
import vm from "node:vm";
import { deflate, inflate } from "node:zlib";
import { Schema } from "effect";
import type { MusicSourceResolveRequest } from "../src/lib/protocol";
import { decodeRuntimeValue, encodeRuntimeValue } from "../src/lib/server/music/runtime-codec";
import {
  RuntimeParentMessage,
  type RuntimeChildMessage,
} from "../src/lib/server/music/runtime-protocol";

interface HttpCallback {
  (error: Error | null, response: unknown, body: unknown): void;
}

const EVENT_NAMES = {
  request: "request",
  inited: "inited",
  updateAlert: "updateAlert",
};
const pendingHttp = new Map<string, HttpCallback>();
let context: vm.Context | undefined;
let requestHandlerRegistered = false;
let initialized = false;
let updateSent = false;
let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line.trim() !== "") void handleLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("uncaughtException", (cause) => fatal(cause));
process.on("unhandledRejection", (cause) => fatal(cause));

async function handleLine(line: string): Promise<void> {
  let message: typeof RuntimeParentMessage.Type;
  try {
    const raw: unknown = decodeRuntimeValue(JSON.parse(line));
    message = Schema.decodeUnknownSync(RuntimeParentMessage)(raw);
  } catch (cause) {
    fatal(cause);
    return;
  }

  switch (message._tag) {
    case "init":
      initialize(message.script, message.metadata);
      break;
    case "resolve":
      await resolveRequest(message.id, message.request);
      break;
    case "httpResponse":
      completeHttp(message.id, message.ok, message.value);
      break;
    case "shutdown":
      process.exit(0);
  }
}

function initialize(
  script: string,
  metadata: typeof import("../src/lib/protocol").MusicSourceMetadata.Type,
): void {
  if (context !== undefined) {
    fatal(new Error("Runtime is already initialized"));
    return;
  }

  const sandbox: Record<string, unknown> = {};
  Object.setPrototypeOf(sandbox, null);
  const lx = {
    EVENT_NAMES,
    version: "2.0.0",
    env: "desktop",
    currentScriptInfo: {
      name: metadata.name,
      description: metadata.description,
      version: metadata.version,
      author: metadata.author,
      homepage: metadata.homepage,
      rawScript: script,
    },
    request: requestHttp,
    send: sendEvent,
    on: onEvent,
    utils: {
      crypto: {
        aesEncrypt(buffer: unknown, mode: string, key: unknown, iv: unknown) {
          const cipher = createCipheriv(mode, toBuffer(key), toBuffer(iv));
          return Buffer.concat([cipher.update(toBuffer(buffer)), cipher.final()]);
        },
        rsaEncrypt(buffer: unknown, key: string | Buffer) {
          const value = toBuffer(buffer);
          if (value.length > 128) throw new Error("RSA input is too large");
          return publicEncrypt(
            { key, padding: constants.RSA_NO_PADDING },
            Buffer.concat([Buffer.alloc(128 - value.length), value]),
          );
        },
        randomBytes(size: number) {
          if (!Number.isSafeInteger(size) || size < 0 || size > 65_536) {
            throw new Error("Invalid random byte count");
          }
          return randomBytes(size);
        },
        md5(value: string) {
          return createHash("md5").update(value).digest("hex");
        },
      },
      buffer: {
        from(value: unknown, encoding?: unknown) {
          if (typeof value === "string") {
            return Buffer.from(
              value,
              typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : "utf8",
            );
          }
          return toBuffer(value);
        },
        bufToString(value: unknown, encoding?: unknown) {
          const format =
            typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : "utf8";
          return toBuffer(value).toString(format);
        },
      },
      zlib: {
        inflate(value: unknown) {
          return zlibOperation(inflate, toBuffer(value));
        },
        deflate(value: unknown) {
          return zlibOperation(deflate, toBuffer(value));
        },
      },
    },
  };

  Object.assign(sandbox, {
    lx,
    __lxLog: logFromContext,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    atob,
    btoa,
  });
  context = vm.createContext(sandbox, {
    name: `serpentia-music-${metadata.digest.slice(0, 12)}`,
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(
    `
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.console = Object.create(null);
    for (const level of ["debug", "info", "warn", "error"]) {
      globalThis.console[level] = function(...args) {
        globalThis.__lxLog(level, args);
      };
    }
    globalThis.console.log = globalThis.console.info;
  `,
    context,
    { timeout: 1_000 },
  );
  vm.runInContext(
    `
    globalThis.__lxOriginalBind = Function.prototype.bind;
    Function.prototype.bind = function(...args) {
      if (this === globalThis && args[0] === globalThis.console) {
        return globalThis.__lxOriginalBind.apply(globalThis.console.log, args);
      }
      return globalThis.__lxOriginalBind.apply(this, args);
    };
  `,
    context,
    { timeout: 1_000 },
  );
  try {
    vm.runInContext(script, context, { timeout: 5_000, filename: "music-source.js" });
  } catch (cause) {
    fatal(cause);
  }
}

function requestHttp(
  url: unknown,
  options: unknown = { method: "GET" },
  callback: unknown,
): () => void {
  if (typeof url !== "string" || typeof callback !== "function") {
    throw new Error("Invalid lx.request arguments");
  }
  const id = crypto.randomUUID();
  const invokeCallback: HttpCallback = (error, response, body) => {
    Reflect.apply(callback, undefined, [error, response, body]);
  };
  pendingHttp.set(id, invokeCallback);
  send({ _tag: "httpRequest", id, url, options: encodeRuntimeValue(options) });
  return () => {
    if (!pendingHttp.delete(id)) return;
    send({ _tag: "httpCancel", id });
  };
}

function sendEvent(eventName: unknown, value: unknown): Promise<void> {
  if (eventName === EVENT_NAMES.inited) {
    if (initialized) return Promise.reject(new Error("Script is inited"));
    initialized = true;
    const sources = isRecord(value) ? value.sources : undefined;
    send({ _tag: "ready", sources: encodeRuntimeValue(sources) });
    return Promise.resolve();
  }
  if (eventName === EVENT_NAMES.updateAlert) {
    if (updateSent) return Promise.reject(new Error("The update alert can only be called once"));
    updateSent = true;
    send({ _tag: "update", value: encodeRuntimeValue(value) });
    return Promise.resolve();
  }
  return Promise.reject(new Error(`The event is not supported: ${String(eventName)}`));
}

function onEvent(eventName: unknown, handler: unknown): Promise<void> {
  if (eventName !== EVENT_NAMES.request || typeof handler !== "function") {
    return Promise.reject(new Error(`The event is not supported: ${String(eventName)}`));
  }
  if (context === undefined) return Promise.reject(new Error("Runtime context is unavailable"));
  context.__lxRequestHandler = handler;
  requestHandlerRegistered = true;
  return Promise.resolve();
}

async function resolveRequest(id: string, request: MusicSourceResolveRequest): Promise<void> {
  if (!requestHandlerRegistered || context === undefined) {
    send({ _tag: "result", id, ok: false, value: "Request event is not defined" });
    return;
  }
  const inputName = `__lxRequest_${id.replaceAll("-", "_")}`;
  try {
    context[inputName] = request;
    const pending: unknown = vm.runInContext(
      `Promise.resolve(globalThis.__lxRequestHandler.call(globalThis.lx, globalThis.${inputName}))`,
      context,
      { timeout: 1_000 },
    );
    delete context[inputName];
    const value = await Promise.resolve(pending);
    send({ _tag: "result", id, ok: true, value: encodeRuntimeValue(value) });
  } catch (cause) {
    delete context[inputName];
    send({ _tag: "result", id, ok: false, value: messageOf(cause) });
  }
}

function completeHttp(id: string, ok: boolean, value: unknown): void {
  const callback = pendingHttp.get(id);
  if (callback === undefined) return;
  pendingHttp.delete(id);
  if (!ok) {
    callback(new Error(typeof value === "string" ? value : "HTTP request failed"), null, null);
    return;
  }
  if (!isRecord(value)) {
    callback(new Error("Malformed HTTP response"), null, null);
    return;
  }
  callback(null, value.response, value.body);
}

function logFromContext(level: unknown, values: unknown): void {
  const normalizedLevel =
    level === "debug" || level === "warn" || level === "error" ? level : "info";
  const args = Array.isArray(values) ? values : [values];
  const message = args.map(logValue).join(" ").slice(0, 2_048);
  send({ _tag: "log", level: normalizedLevel, message });
}

function send(message: RuntimeChildMessage): void {
  process.stdout.write(`${JSON.stringify(encodeRuntimeValue(message))}\n`);
}

function fatal(cause: unknown): void {
  send({ _tag: "fatal", message: messageOf(cause).slice(0, 2_048) });
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 10).unref();
}

function zlibOperation(
  operation: (value: Uint8Array, callback: (error: Error | null, data: Buffer) => void) => void,
  value: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    operation(value, (error, data) => (error === null ? resolve(data) : reject(error)));
  });
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return Buffer.from(value);
  }
  throw new Error("Expected binary data");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function logValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(encodeRuntimeValue(value));
  } catch {
    return String(value);
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
