import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import type { MusicSourceMetadata, MusicSourceResolveRequest } from "../../protocol";
import { musicSourceError } from "./errors";
import { MusicOutboundHttp } from "./outbound-http";
import { decodeRuntimeValue, encodeRuntimeValue } from "./runtime-codec";
import { RuntimeChildMessage, type RuntimeParentMessage } from "./runtime-protocol";

const INITIALIZATION_TIMEOUT_MS = 5_000;
const RESOLUTION_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_BYTES = 4_194_304;
const CHILD_PATH = fileURLToPath(new URL("../../../../server/music-runtime.ts", import.meta.url));

interface PendingResolution {
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}

export interface MusicRuntimeOptions {
  readonly http?: MusicOutboundHttp;
  readonly onUpdate?: (value: unknown) => void;
}

export class MusicRuntime {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly http: MusicOutboundHttp;
  private readonly onUpdate: ((value: unknown) => void) | undefined;
  private readonly pending = new Map<string, PendingResolution>();
  private readonly httpRequests = new Map<string, AbortController>();
  private readonly readyPromise: Promise<unknown>;
  private resolveReady: ((sources: unknown) => void) | undefined;
  private rejectReady: ((cause: unknown) => void) | undefined;
  private stdoutBuffer = "";
  private stderrBytes = 0;
  private closed = false;

  private constructor(options: MusicRuntimeOptions) {
    this.http = options.http ?? new MusicOutboundHttp();
    this.onUpdate = options.onUpdate;
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const executable = process.versions.bun === undefined ? "bun" : process.execPath;
    this.child = spawn(executable, [CHILD_PATH], {
      cwd: process.cwd(),
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "production",
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.acceptStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.acceptStderr(chunk));
    this.child.once("error", (cause) => this.failRuntime(cause));
    this.child.once("exit", (code, signal) => {
      if (!this.closed)
        this.failRuntime(new Error(`Music runtime exited (${code ?? signal ?? "unknown"})`));
    });
  }

  static async start(
    script: string,
    metadata: MusicSourceMetadata,
    options: MusicRuntimeOptions = {},
  ): Promise<{ readonly runtime: MusicRuntime; readonly sources: unknown }> {
    const runtime = new MusicRuntime(options);
    runtime.send({ _tag: "init", script, metadata });
    const timer = setTimeout(
      () =>
        runtime.rejectReady?.(
          musicSourceError("INITIALIZATION_FAILED", "Music source initialization timed out"),
        ),
      INITIALIZATION_TIMEOUT_MS,
    );
    try {
      const sources = await runtime.readyPromise;
      return { runtime, sources };
    } catch (cause) {
      await runtime.dispose();
      if (cause instanceof Error && cause.name === "MusicSourceError") throw cause;
      throw musicSourceError("INITIALIZATION_FAILED", messageOf(cause));
    } finally {
      clearTimeout(timer);
      runtime.resolveReady = undefined;
      runtime.rejectReady = undefined;
    }
  }

  get alive(): boolean {
    return !this.closed && this.child.exitCode === null;
  }

  resolve(request: MusicSourceResolveRequest, signal?: AbortSignal): Promise<unknown> {
    if (!this.alive)
      return Promise.reject(
        musicSourceError("RUNTIME_UNAVAILABLE", "Music runtime is unavailable"),
      );
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort =
        signal === undefined
          ? undefined
          : () => {
              const pending = this.takePending(id);
              pending?.reject(musicSourceError("TIMEOUT", "Music request was cancelled"));
            };
      if (signal?.aborted) {
        reject(musicSourceError("TIMEOUT", "Music request was cancelled"));
        return;
      }
      signal?.addEventListener("abort", abort ?? (() => undefined), { once: true });
      const timer = setTimeout(() => {
        const pending = this.takePending(id);
        pending?.reject(musicSourceError("TIMEOUT", "Music source request timed out"));
        this.failRuntime(new Error("Music source handler exceeded its deadline"));
      }, RESOLUTION_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, signal, abort });
      this.send({ _tag: "resolve", id, request });
    });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.send({ _tag: "shutdown" });
    } catch {
      // The child may already be gone.
    }
    for (const controller of this.httpRequests.values()) controller.abort();
    this.httpRequests.clear();
    for (const [id, pending] of this.pending) {
      this.cleanupPending(pending);
      pending.reject(musicSourceError("RUNTIME_UNAVAILABLE", "Music runtime stopped"));
      this.pending.delete(id);
    }
    await Promise.race([
      new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }

  private acceptStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (new TextEncoder().encode(this.stdoutBuffer).byteLength > MAX_MESSAGE_BYTES) {
      this.failRuntime(new Error("Music runtime message is too large"));
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim() !== "") this.acceptLine(line);
    }
  }

  private acceptLine(line: string): void {
    let message: typeof RuntimeChildMessage.Type;
    try {
      const decoded: unknown = decodeRuntimeValue(JSON.parse(line));
      message = Schema.decodeUnknownSync(RuntimeChildMessage)(decoded);
    } catch (cause) {
      this.failRuntime(cause);
      return;
    }

    switch (message._tag) {
      case "ready":
        this.resolveReady?.(message.sources);
        break;
      case "result": {
        const pending = this.takePending(message.id);
        if (pending === undefined) break;
        if (message.ok) pending.resolve(message.value);
        else pending.reject(musicSourceError("UPSTREAM_FAILED", safeMessage(message.value)));
        break;
      }
      case "httpRequest":
        void this.handleHttpRequest(message.id, message.url, message.options);
        break;
      case "httpCancel":
        this.httpRequests.get(message.id)?.abort();
        this.httpRequests.delete(message.id);
        break;
      case "update":
        this.onUpdate?.(message.value);
        break;
      case "log":
        console.log(
          JSON.stringify({
            level: message.level,
            event: "music_source_log",
            message: message.message,
          }),
        );
        break;
      case "fatal":
        this.failRuntime(new Error(message.message));
    }
  }

  private async handleHttpRequest(id: string, url: string, options: unknown): Promise<void> {
    if (this.closed) return;
    const controller = new AbortController();
    this.httpRequests.set(id, controller);
    try {
      const value = await this.http.request(url, options, controller.signal);
      if (!controller.signal.aborted && this.alive) {
        this.send({ _tag: "httpResponse", id, ok: true, value });
      }
    } catch (cause) {
      if (!controller.signal.aborted && this.alive) {
        this.send({ _tag: "httpResponse", id, ok: false, value: messageOf(cause) });
      }
    } finally {
      this.httpRequests.delete(id);
    }
  }

  private acceptStderr(chunk: string): void {
    if (this.stderrBytes >= 8_192) return;
    this.stderrBytes += new TextEncoder().encode(chunk).byteLength;
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "music_runtime_stderr",
        message: chunk.slice(0, 2_048),
      }),
    );
  }

  private failRuntime(cause: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectReady?.(cause);
    for (const controller of this.httpRequests.values()) controller.abort();
    this.httpRequests.clear();
    for (const [id, pending] of this.pending) {
      this.cleanupPending(pending);
      pending.reject(musicSourceError("RUNTIME_UNAVAILABLE", messageOf(cause)));
      this.pending.delete(id);
    }
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }

  private takePending(id: string): PendingResolution | undefined {
    const pending = this.pending.get(id);
    if (pending === undefined) return undefined;
    this.pending.delete(id);
    this.cleanupPending(pending);
    return pending;
  }

  private cleanupPending(pending: PendingResolution): void {
    clearTimeout(pending.timer);
    if (pending.abort !== undefined) pending.signal?.removeEventListener("abort", pending.abort);
  }

  private send(message: RuntimeParentMessage): void {
    if (this.child.stdin.destroyed)
      throw musicSourceError("RUNTIME_UNAVAILABLE", "Music runtime input is closed");
    this.child.stdin.write(`${JSON.stringify(encodeRuntimeValue(message))}\n`);
  }
}

function safeMessage(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 256) : "Music source request failed";
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Music runtime failed";
}
