import type { BackendDescriptor, SessionErrorCode, SessionInfo } from "$lib/protocol";

export type SessionState =
  | { status: "loading" }
  | { status: "anonymous"; descriptor: BackendDescriptor }
  | { status: "authenticated"; descriptor: BackendDescriptor; session: SessionInfo }
  | { status: "unavailable"; message: string };

const ERROR_MESSAGES: Record<SessionErrorCode, string> = {
  INVALID_REQUEST: "请求格式有误，请重试",
  INVALID_ACCESS: "访问码或昵称不正确",
  RATE_LIMITED: "尝试太频繁了，休息一分钟再来",
  RUNTIME_UNAVAILABLE: "服务暂时不可用，请稍后再试",
  SERVER_MISCONFIGURED: "服务器配置异常，请联系房主",
};

/**
 * 会话与启动信息管理（Svelte 响应式 store）。
 * 负责 /api/game 与 /api/session 的全部交互。
 */
export class SessionStore {
  state = $state<SessionState>({ status: "loading" });

  async bootstrap(): Promise<void> {
    this.state = { status: "loading" };
    let descriptor: BackendDescriptor;
    try {
      const response = await fetch("/api/game", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(String(response.status));
      descriptor = (await response.json()) as BackendDescriptor;
    } catch {
      this.state = { status: "unavailable", message: "无法连接服务器，请检查网络后刷新" };
      return;
    }
    try {
      const response = await fetch("/api/session", { headers: { accept: "application/json" } });
      const status = (await response.json()) as SessionInfo | { authenticated: false };
      if (status.authenticated) {
        this.state = { status: "authenticated", descriptor, session: status };
      } else {
        this.state = { status: "anonymous", descriptor };
      }
    } catch {
      this.state = { status: "anonymous", descriptor };
    }
  }

  async login(key: string, nickname: string): Promise<string | undefined> {
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ key, nickname }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          | { error?: SessionErrorCode }
          | undefined;
        return (body?.error && ERROR_MESSAGES[body.error]) ?? "登录失败，请稍后再试";
      }
      const session = (await response.json()) as SessionInfo;
      const descriptor =
        this.state.status === "anonymous" || this.state.status === "authenticated"
          ? this.state.descriptor
          : undefined;
      if (!descriptor) {
        await this.bootstrap();
        return undefined;
      }
      this.state = { status: "authenticated", descriptor, session };
      return undefined;
    } catch {
      return "网络异常，请稍后再试";
    }
  }

  async logout(): Promise<void> {
    try {
      await fetch("/api/session", { method: "DELETE" });
    } finally {
      const descriptor =
        this.state.status === "authenticated" ? this.state.descriptor : undefined;
      if (descriptor) this.state = { status: "anonymous", descriptor };
      else await this.bootstrap();
    }
  }

  /** 会话过期（WS 侧 SESSION_EXPIRED）时回到登录页。 */
  markExpired(): void {
    const descriptor = this.state.status === "authenticated" ? this.state.descriptor : undefined;
    if (descriptor) this.state = { status: "anonymous", descriptor };
  }
}
