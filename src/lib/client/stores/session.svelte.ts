import { Schema } from "effect";
import { DEFAULT_SKIN_ID, isInternalSkinId } from "$lib/game/internal-skins";
import {
  GameBootstrapResponse,
  SessionErrorResponse,
  SessionInfo,
  SessionStatus,
  type BackendDescriptor,
  type SessionErrorCode,
} from "$lib/protocol";

export type SessionState =
  | { status: "loading" }
  | { status: "anonymous"; descriptor: BackendDescriptor | undefined }
  | { status: "authenticated"; descriptor: BackendDescriptor; session: SessionInfo }
  | { status: "unavailable"; message: string };

export type InitialSessionState = Exclude<SessionState, { status: "loading" }>;
type SessionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class SessionProtocolError extends Schema.TaggedErrorClass<SessionProtocolError>()(
  "SessionProtocolError",
  {
    stage: Schema.Literals(["bootstrap", "session-status", "session-info"]),
    cause: Schema.Defect(),
  },
) {}

const decodeSessionError = Schema.decodeUnknownSync(SessionErrorResponse);
const NICKNAME_STORAGE_KEY = "serpentia.nickname";
const SKIN_STORAGE_KEY = "serpentia.skin-id";
const DEFAULT_SESSION_PATH = "/api/session";

const ERROR_MESSAGES: Record<SessionErrorCode, string> = {
  INVALID_REQUEST: "请求格式有误，请重试",
  RATE_LIMITED: "尝试太频繁了，请稍后再试",
  RUNTIME_UNAVAILABLE: "服务暂时不可用，请稍后再试",
  SERVER_MISCONFIGURED: "服务器配置异常，请联系房主",
};

/** 在页面渲染前并行读取、校验后端描述与会话状态。 */
export async function loadInitialSessionState(fetcher: SessionFetch): Promise<InitialSessionState> {
  const descriptorRequest = request(fetcher, "/api/game", {
    headers: { accept: "application/json" },
  });
  const sessionRequest = request(fetcher, DEFAULT_SESSION_PATH, {
    headers: { accept: "application/json" },
  });
  const [descriptorResponse, sessionResponse] = await Promise.all([
    descriptorRequest,
    sessionRequest,
  ]);

  if (descriptorResponse === undefined || !descriptorResponse.ok) {
    return { status: "unavailable", message: "无法连接服务器，请检查网络后刷新" };
  }
  const descriptor = await decodeBackendDescriptor(descriptorResponse);

  if (sessionResponse === undefined || !sessionResponse.ok) {
    return { status: "unavailable", message: "无法验证游戏会话，请稍后重试" };
  }
  const status = await decodeSessionStatus(sessionResponse);
  return status.authenticated
    ? { status: "authenticated", descriptor, session: status }
    : { status: "anonymous", descriptor };
}

/** Session bootstrap and authentication with schema-validated HTTP boundaries. */
export class SessionStore {
  state = $state<SessionState>({ status: "loading" });
  savedNickname = $state(loadNickname());
  savedSkinId = $state(loadSkinId());
  private operation = 0;

  constructor(
    initialState: SessionState = { status: "loading" },
    private readonly fetcher: SessionFetch = globalThis.fetch,
  ) {
    this.acceptState(initialState);
  }

  async bootstrap(): Promise<void> {
    const operation = ++this.operation;
    this.state = { status: "loading" };
    try {
      const nextState = await loadInitialSessionState(this.fetcher);
      if (this.operation === operation) this.acceptState(nextState);
    } catch (cause) {
      console.error("Session bootstrap protocol failure", cause);
      if (this.operation === operation) {
        this.state = { status: "unavailable", message: "服务器数据格式异常，请刷新后重试" };
      }
    }
  }

  async login(nickname: string, skinId = this.savedSkinId): Promise<string | undefined> {
    const operation = ++this.operation;
    const selectedSkinId = isInternalSkinId(skinId) ? skinId : DEFAULT_SKIN_ID;
    this.savedNickname = nickname;
    this.savedSkinId = selectedSkinId;
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(NICKNAME_STORAGE_KEY, nickname);
        localStorage.setItem(SKIN_STORAGE_KEY, String(selectedSkinId));
      } catch {
        // Login still works when browser storage is unavailable.
      }
    }
    const descriptor =
      this.state.status === "anonymous" || this.state.status === "authenticated"
        ? this.state.descriptor
        : undefined;
    const descriptorRequest =
      descriptor === undefined
        ? request(this.fetcher, "/api/game", { headers: { accept: "application/json" } })
        : undefined;
    try {
      const response = await this.fetcher(descriptor?.sessionPath ?? DEFAULT_SESSION_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ nickname, skinId: selectedSkinId }),
      });
      if (!response.ok) {
        try {
          const body = decodeSessionError(await response.json());
          return sessionErrorMessage(body.error, response.headers.get("retry-after"));
        } catch {
          return "进入游戏失败，请稍后再试";
        }
      }
      const session = await decodeSessionInfo(response);
      if (this.operation !== operation) return undefined;

      let resolvedDescriptor: BackendDescriptor;
      if (descriptor === undefined) {
        const descriptorResponse = await descriptorRequest;
        if (descriptorResponse === undefined || !descriptorResponse.ok) {
          if (this.operation === operation) {
            this.state = {
              status: "unavailable",
              message: "游戏会话已创建，但无法读取游戏配置，请重试",
            };
          }
          return undefined;
        }
        resolvedDescriptor = await decodeBackendDescriptor(descriptorResponse);
      } else {
        resolvedDescriptor = descriptor;
      }

      this.savedSkinId = session.skinId;
      saveSkinId(session.skinId);
      this.state = { status: "authenticated", descriptor: resolvedDescriptor, session };
      return undefined;
    } catch (cause) {
      if (cause instanceof SessionProtocolError) {
        console.error("Session response protocol failure", cause);
        return this.operation === operation ? "服务器数据格式异常，请刷新后重试" : undefined;
      }
      return this.operation === operation ? "网络异常，请稍后再试" : undefined;
    }
  }

  async endSession(keepalive = false): Promise<void> {
    const operation = ++this.operation;
    const descriptor = this.state.status === "authenticated" ? this.state.descriptor : undefined;
    if (descriptor) this.state = { status: "anonymous", descriptor };
    try {
      await this.fetcher(descriptor?.sessionPath ?? DEFAULT_SESSION_PATH, {
        method: "DELETE",
        keepalive,
      });
    } catch {
      // The local session is already cleared; page-exit delivery is best effort.
    } finally {
      if (!descriptor && this.operation === operation) await this.bootstrap();
    }
  }

  /** Clears the local game session immediately when the WebSocket reports expiration. */
  markExpired(): void {
    this.operation += 1;
    const descriptor = this.state.status === "authenticated" ? this.state.descriptor : undefined;
    if (descriptor) this.state = { status: "anonymous", descriptor };
  }

  private acceptState(state: SessionState): void {
    if (state.status === "authenticated") {
      this.savedSkinId = state.session.skinId;
      saveSkinId(state.session.skinId);
    }
    this.state = state;
  }
}

export function sessionErrorMessage(
  error: SessionErrorCode,
  retryAfter: string | null,
  now = Date.now(),
): string {
  if (error !== "RATE_LIMITED") return ERROR_MESSAGES[error];
  const seconds = parseRetryAfterSeconds(retryAfter, now);
  return seconds === undefined
    ? ERROR_MESSAGES.RATE_LIMITED
    : `尝试太频繁了，请 ${seconds} 秒后再试`;
}

function parseRetryAfterSeconds(value: string | null, now: number): number | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return undefined;
  if (/^\d+$/u.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds) ? Math.max(1, seconds) : undefined;
  }
  const retryAt = Date.parse(normalized);
  return Number.isFinite(retryAt) && retryAt > now
    ? Math.max(1, Math.ceil((retryAt - now) / 1000))
    : undefined;
}

function loadNickname(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(NICKNAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function loadSkinId(): number {
  if (typeof window === "undefined") return DEFAULT_SKIN_ID;
  try {
    const value = Number(localStorage.getItem(SKIN_STORAGE_KEY));
    return isInternalSkinId(value) ? value : DEFAULT_SKIN_ID;
  } catch {
    return DEFAULT_SKIN_ID;
  }
}

function saveSkinId(skinId: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, String(skinId));
  } catch {
    // The in-memory selection remains usable when persistence is unavailable.
  }
}

async function request(
  fetcher: SessionFetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response | undefined> {
  try {
    return await fetcher(input, init);
  } catch {
    return undefined;
  }
}

async function decodeBackendDescriptor(response: Response): Promise<BackendDescriptor> {
  try {
    return await Schema.decodeUnknownPromise(GameBootstrapResponse)(await response.json());
  } catch (cause) {
    throw SessionProtocolError.make({ stage: "bootstrap", cause });
  }
}

async function decodeSessionStatus(response: Response): Promise<SessionStatus> {
  try {
    return await Schema.decodeUnknownPromise(SessionStatus)(await response.json());
  } catch (cause) {
    throw SessionProtocolError.make({ stage: "session-status", cause });
  }
}

async function decodeSessionInfo(response: Response): Promise<SessionInfo> {
  try {
    return await Schema.decodeUnknownPromise(SessionInfo)(await response.json());
  } catch (cause) {
    throw SessionProtocolError.make({ stage: "session-info", cause });
  }
}
