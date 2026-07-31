import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  MusicLyricResolveResult,
  MusicPictureResolveResult,
  MusicSourceCapability,
  MusicSourceEntry,
  MusicSourceUpdateInfo,
  MusicUrlResolveResult,
  type MusicSourceAction,
  type MusicSourcePlatform,
  type MusicSourceResolveRequest,
  type MusicSourceResolveResponse,
  type MusicSourceStatusResponse,
} from "../../protocol";
import { isMusicSourceError, musicSourceError } from "./errors";
import { parseMusicSourceScript } from "./metadata";
import { MusicOutboundHttp } from "./outbound-http";
import { MusicRuntime } from "./runtime";

const MAX_INFO_BYTES = 16_384;
const platforms: ReadonlyArray<MusicSourcePlatform> = ["kw", "kg", "tx", "wy", "mg", "local"];
const actionsBySource: Readonly<Record<MusicSourcePlatform, ReadonlyArray<MusicSourceAction>>> = {
  kw: ["musicUrl"],
  kg: ["musicUrl"],
  tx: ["musicUrl"],
  wy: ["musicUrl"],
  mg: ["musicUrl"],
  local: ["musicUrl", "lyric", "pic"],
};
const qualitysBySource: Readonly<Record<MusicSourcePlatform, ReadonlyArray<string>>> = {
  kw: ["128k", "320k", "flac", "flac24bit"],
  kg: ["128k", "320k", "flac", "flac24bit"],
  tx: ["128k", "320k", "flac", "flac24bit"],
  wy: ["128k", "320k", "flac", "flac24bit"],
  mg: ["128k", "320k", "flac", "flac24bit"],
  local: [],
};

export interface MusicSourceServiceOptions {
  readonly sourceFile: string;
  readonly http?: MusicOutboundHttp;
  readonly watch?: boolean;
}

export class MusicSourceService {
  private readonly http: MusicOutboundHttp;
  private readonly watchFile: boolean;
  private runtime: MusicRuntime | undefined;
  private entry: MusicSourceEntry | undefined;
  private update: MusicSourceUpdateInfo | null = null;
  private watcher: FSWatcher | undefined;
  private reloading: Promise<void> = Promise.resolve();
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly sourceFile: string,
    options: MusicSourceServiceOptions,
  ) {
    this.http = options.http ?? new MusicOutboundHttp();
    this.watchFile = options.watch ?? true;
  }

  static disabled(): MusicSourceService {
    return new MusicSourceService("__disabled_music_source__", {
      sourceFile: "__disabled_music_source__",
      watch: false,
    });
  }

  static async create(options: MusicSourceServiceOptions): Promise<MusicSourceService> {
    const service = new MusicSourceService(options.sourceFile, options);
    await service.reload(true);
    if (service.watchFile) service.startWatching();
    return service;
  }

  status(): MusicSourceStatusResponse {
    return { active: this.entry ?? null, update: this.update };
  }

  async resolve(
    request: MusicSourceResolveRequest,
    signal?: AbortSignal,
  ): Promise<MusicSourceResolveResponse> {
    validateInfo(request.info);
    const runtime = this.runtime;
    const entry = this.entry;
    if (runtime === undefined || entry === undefined || !runtime.alive) {
      await this.reload(true);
    }
    const activeRuntime = this.runtime;
    const activeEntry = this.entry;
    if (activeRuntime === undefined || activeEntry === undefined) {
      throw musicSourceError("SOURCE_UNAVAILABLE", "No valid music-source.js is active");
    }
    const capability = activeEntry.sources.find((item) => item.source === request.source);
    if (capability === undefined || !capability.actions.includes(request.action)) {
      throw musicSourceError("INVALID_REQUEST", "Music source does not advertise this action");
    }
    if (request.action === "musicUrl" && request.source !== "local") {
      const type = requiredQualityFromInfo(request.info);
      if (!capability.qualitys.includes(type)) {
        throw musicSourceError("INVALID_REQUEST", "Music source does not advertise this quality");
      }
    }

    try {
      const value = await activeRuntime.resolve(request, signal);
      return await this.normalizeResult(request, value);
    } catch (cause) {
      if (isMusicSourceError(cause) && cause.code === "RUNTIME_UNAVAILABLE") {
        await this.reload(true);
      }
      throw cause;
    }
  }

  async reload(force = false): Promise<void> {
    const operation = this.reloading.then(
      () => this.load(force),
      () => this.load(force),
    );
    this.reloading = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async dispose(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.reloadTimer !== undefined) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    const runtime = this.runtime;
    this.runtime = undefined;
    this.entry = undefined;
    this.update = null;
    await runtime?.dispose();
  }

  private async load(force: boolean): Promise<void> {
    let script: string;
    try {
      script = await readFile(this.sourceFile, "utf8");
    } catch (cause) {
      if (isMissingFile(cause)) {
        const runtime = this.runtime;
        this.runtime = undefined;
        this.entry = undefined;
        this.update = null;
        await runtime?.dispose();
        return;
      }
      throw musicSourceError("SOURCE_UNAVAILABLE", messageOf(cause));
    }

    const parsed = parseMusicSourceScript(script);
    if (!force && this.entry?.metadata.digest === parsed.metadata.digest && this.runtime?.alive)
      return;

    let candidate: MusicRuntime | undefined;
    let candidateEntry: MusicSourceEntry | undefined;
    let candidateUpdate: MusicSourceUpdateInfo | null = null;
    try {
      const started = await MusicRuntime.start(parsed.script, parsed.metadata, {
        http: this.http,
        onUpdate: (value) => {
          const update = normalizeUpdate(value);
          if (candidate !== undefined && candidate === this.runtime) this.update = update;
          else candidateUpdate = update;
        },
      });
      candidate = started.runtime;
      candidateEntry = MusicSourceEntry.make({
        metadata: parsed.metadata,
        sources: normalizeCapabilities(started.sources),
      });
      if (candidateEntry.sources.length === 0) {
        throw musicSourceError(
          "INITIALIZATION_FAILED",
          "Music source did not advertise usable capabilities",
        );
      }
    } catch (cause) {
      await candidate?.dispose();
      if (this.runtime === undefined) {
        this.entry = undefined;
        this.update = null;
      }
      throw isMusicSourceError(cause)
        ? cause
        : musicSourceError("INITIALIZATION_FAILED", messageOf(cause));
    }

    const previous = this.runtime;
    this.runtime = candidate;
    this.entry = candidateEntry;
    this.update = candidateUpdate;
    await previous?.dispose();
  }

  private startWatching(): void {
    const directory = dirname(this.sourceFile);
    const fileName = basename(this.sourceFile);
    this.watcher = watch(directory, { persistent: false }, (_event, changed) => {
      if (changed !== fileName) return;
      if (this.reloadTimer !== undefined) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = undefined;
        void this.reload().catch((cause) => {
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "music_source_reload_failed",
              message: messageOf(cause),
            }),
          );
        });
      }, 150);
    });
    this.watcher.on("error", (cause) => {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "music_source_watch_failed",
          message: messageOf(cause),
        }),
      );
    });
  }

  private async normalizeResult(
    request: MusicSourceResolveRequest,
    value: unknown,
  ): Promise<MusicSourceResolveResponse> {
    if (request.action === "musicUrl") {
      if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
        throw musicSourceError("UPSTREAM_FAILED", "Music source returned an invalid URL");
      }
      const url = await this.http.assertPublicUrl(value);
      const type = optionalQualityFromInfo(request.info);
      return MusicUrlResolveResult.make({
        source: request.source,
        action: "musicUrl",
        data: { ...(type === undefined ? {} : { type }), url: url.toString() },
      });
    }
    if (request.action === "pic") {
      if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
        throw musicSourceError("UPSTREAM_FAILED", "Music source returned an invalid image URL");
      }
      const url = await this.http.assertPublicUrl(value);
      return MusicPictureResolveResult.make({
        source: request.source,
        action: "pic",
        data: url.toString(),
      });
    }
    if (!isRecord(value) || typeof value.lyric !== "string" || value.lyric.length > 51_200) {
      throw musicSourceError("UPSTREAM_FAILED", "Music source returned invalid lyrics");
    }
    return MusicLyricResolveResult.make({
      source: request.source,
      action: "lyric",
      data: {
        lyric: value.lyric,
        tlyric: boundedOptionalString(value.tlyric, 5_120),
        rlyric: boundedOptionalString(value.rlyric, 5_120),
        lxlyric: boundedOptionalString(value.lxlyric, 8_192),
      },
    });
  }
}

function normalizeCapabilities(value: unknown): Array<MusicSourceCapability> {
  if (!isRecord(value)) return [];
  const capabilities: Array<MusicSourceCapability> = [];
  for (const source of platforms) {
    const candidate = value[source];
    if (!isRecord(candidate) || candidate.type !== "music") continue;
    const allowedActions = actionsBySource[source];
    const allowedQualitys = qualitysBySource[source];
    const actions = uniqueStrings(candidate.actions)
      .filter(isAction)
      .filter((action) => allowedActions.includes(action));
    const qualitys = uniqueStrings(candidate.qualitys)
      .filter(isQuality)
      .filter((quality) => allowedQualitys.includes(quality));
    if (actions.length === 0) continue;
    capabilities.push(
      MusicSourceCapability.make({
        source,
        name:
          typeof candidate.name === "string" && candidate.name.length > 0
            ? candidate.name.slice(0, 64)
            : source,
        type: "music",
        actions,
        qualitys,
      }),
    );
  }
  return capabilities;
}

function validateInfo(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_INFO_BYTES) {
    throw musicSourceError("INVALID_REQUEST", "Music request information is too large");
  }
  validateJsonValue(value, 0);
}

function validateJsonValue(value: unknown, depth: number): void {
  if (depth > 8)
    throw musicSourceError("INVALID_REQUEST", "Music request information is too deeply nested");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw musicSourceError("INVALID_REQUEST", "Music request contains a non-finite number");
    return;
  }
  if (typeof value === "string") {
    if (value.length > 2_048)
      throw musicSourceError("INVALID_REQUEST", "Music request contains an oversized string");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 64)
      throw musicSourceError("INVALID_REQUEST", "Music request contains an oversized array");
    for (const item of value) validateJsonValue(item, depth + 1);
    return;
  }
  if (!isRecord(value))
    throw musicSourceError("INVALID_REQUEST", "Music request must contain JSON data");
  const entries = Object.entries(value);
  if (entries.length > 64 || entries.some(([key]) => key.length > 128)) {
    throw musicSourceError("INVALID_REQUEST", "Music request contains too many fields");
  }
  for (const [, item] of entries) validateJsonValue(item, depth + 1);
}

function requiredQualityFromInfo(value: unknown): "128k" | "320k" | "flac" | "flac24bit" {
  const quality = optionalQualityFromInfo(value);
  if (quality === undefined) {
    throw musicSourceError("INVALID_REQUEST", "musicUrl requests require a supported quality");
  }
  return quality;
}

function optionalQualityFromInfo(
  value: unknown,
): "128k" | "320k" | "flac" | "flac24bit" | undefined {
  return isRecord(value) && isQuality(value.type) ? value.type : undefined;
}

function isAction(value: unknown): value is MusicSourceAction {
  return value === "musicUrl" || value === "lyric" || value === "pic";
}

function isQuality(value: unknown): value is "128k" | "320k" | "flac" | "flac24bit" {
  return value === "128k" || value === "320k" || value === "flac" || value === "flac24bit";
}

function normalizeUpdate(value: unknown): MusicSourceUpdateInfo | null {
  if (!isRecord(value) || typeof value.log !== "string" || value.log.length === 0) return null;
  const updateUrl =
    typeof value.updateUrl === "string" ? value.updateUrl.slice(0, 1_024) : undefined;
  return MusicSourceUpdateInfo.make({
    log: value.log.slice(0, 1_024),
    ...(updateUrl === undefined ? {} : { updateUrl }),
  });
}

function boundedOptionalString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function uniqueStrings(value: unknown): Array<string> {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Music source operation failed";
}
