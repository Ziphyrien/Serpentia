import { Schema } from "effect";
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
  | { status: "anonymous"; descriptor: BackendDescriptor }
  | { status: "authenticated"; descriptor: BackendDescriptor; session: SessionInfo }
  | { status: "unavailable"; message: string };

const decodeBootstrap = Schema.decodeUnknownSync(GameBootstrapResponse);
const decodeSessionStatus = Schema.decodeUnknownSync(SessionStatus);
const decodeSessionInfo = Schema.decodeUnknownSync(SessionInfo);
const decodeSessionError = Schema.decodeUnknownSync(SessionErrorResponse);

const ERROR_MESSAGES: Record<SessionErrorCode, string> = {
  INVALID_REQUEST: "请求格式有误，请重试",
  INVALID_ACCESS: "访问码或昵称不正确",
  RATE_LIMITED: "尝试太频繁了，休息一分钟再来",
  RUNTIME_UNAVAILABLE: "服务暂时不可用，请稍后再试",
  SERVER_MISCONFIGURED: "服务器配置异常，请联系房主",
};

/** Session bootstrap and authentication with schema-validated HTTP boundaries. */
export class SessionStore {
  state = $state<SessionState>({ status: "loading" });
  private operation = 0;

  async bootstrap(): Promise<void> {
    const operation = ++this.operation;
    this.state = { status: "loading" };
    let descriptor: BackendDescriptor;
    try {
      const response = await fetch("/api/game", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(String(response.status));
      descriptor = decodeBootstrap(await response.json());
    } catch {
      if (this.operation === operation) {
        this.state = { status: "unavailable", message: "无法连接服务器，请检查网络后刷新" };
      }
      return;
    }

    try {
      const response = await fetch(descriptor.sessionPath, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(String(response.status));
      const status = decodeSessionStatus(await response.json());
      if (this.operation !== operation) return;
      this.state = status.authenticated
        ? { status: "authenticated", descriptor, session: status }
        : { status: "anonymous", descriptor };
    } catch {
      if (this.operation === operation) {
        this.state = { status: "unavailable", message: "无法验证登录状态，请稍后重试" };
      }
    }
  }

  async login(key: string, nickname: string): Promise<string | undefined> {
    const operation = ++this.operation;
    const descriptor =
      this.state.status === "anonymous" || this.state.status === "authenticated"
        ? this.state.descriptor
        : undefined;
    try {
      const response = await fetch(descriptor?.sessionPath ?? "/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ key, nickname }),
      });
      if (!response.ok) {
        try {
          const body = decodeSessionError(await response.json());
          return ERROR_MESSAGES[body.error];
        } catch {
          return "登录失败，请稍后再试";
        }
      }
      const session = decodeSessionInfo(await response.json());
      if (this.operation !== operation) return undefined;
      if (!descriptor) {
        await this.bootstrap();
        return undefined;
      }
      this.state = { status: "authenticated", descriptor, session };
      return undefined;
    } catch {
      return this.operation === operation ? "网络异常，请稍后再试" : undefined;
    }
  }

  async logout(): Promise<void> {
    const operation = ++this.operation;
    const descriptor = this.state.status === "authenticated" ? this.state.descriptor : undefined;
    if (descriptor) this.state = { status: "anonymous", descriptor };
    try {
      await fetch(descriptor?.sessionPath ?? "/api/session", { method: "DELETE" });
    } finally {
      if (!descriptor && this.operation === operation) await this.bootstrap();
    }
  }

  /** Returns to login immediately when the WebSocket reports expiration. */
  markExpired(): void {
    this.operation += 1;
    const descriptor = this.state.status === "authenticated" ? this.state.descriptor : undefined;
    if (descriptor) this.state = { status: "anonymous", descriptor };
  }
}
