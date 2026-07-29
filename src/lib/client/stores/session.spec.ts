import { describe, expect, it } from "vite-plus/test";
import { createBackendDescriptor, createRoomMetadata } from "$lib/server/room/room-settings";
import {
  SessionProtocolError,
  SessionStore,
  loadInitialSessionState,
  sessionErrorMessage,
} from "./session.svelte";

const descriptor = createBackendDescriptor(createRoomMetadata([]));
type SessionFetch = Parameters<typeof loadInitialSessionState>[0];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("initial session bootstrap", () => {
  it("loads and schema-decodes the backend descriptor and session in parallel", async () => {
    const requests: Array<string> = [];
    const fetcher: SessionFetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      return requests.length === 1
        ? jsonResponse(descriptor)
        : jsonResponse({ authenticated: false });
    };

    await expect(loadInitialSessionState(fetcher)).resolves.toEqual({
      status: "anonymous",
      descriptor,
    });
    expect(requests).toEqual(["/api/game", "/api/session"]);
  });

  it("returns the game bootstrap error after starting both parallel requests", async () => {
    let requests = 0;
    const fetcher: SessionFetch = async (input) => {
      requests += 1;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url === "/api/game" ? jsonResponse({}, 503) : jsonResponse({ authenticated: false });
    };

    await expect(loadInitialSessionState(fetcher)).resolves.toEqual({
      status: "unavailable",
      message: "无法连接服务器，请检查网络后刷新",
    });
    expect(requests).toBe(2);
  });

  it("treats a malformed backend descriptor as an unexpected protocol error", async () => {
    const fetcher: SessionFetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url === "/api/game" ? jsonResponse({}) : jsonResponse({ authenticated: false });
    };

    await expect(loadInitialSessionState(fetcher)).rejects.toMatchObject({
      _tag: "SessionProtocolError",
      stage: "bootstrap",
    } satisfies Partial<SessionProtocolError>);
  });

  it("treats a malformed session payload as an unexpected protocol error", async () => {
    const fetcher: SessionFetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url === "/api/game" ? jsonResponse(descriptor) : jsonResponse({ authenticated: "no" });
    };

    await expect(loadInitialSessionState(fetcher)).rejects.toMatchObject({
      _tag: "SessionProtocolError",
      stage: "session-status",
    } satisfies Partial<SessionProtocolError>);
  });
});

describe("session store login", () => {
  it("loads the descriptor in parallel when logging in from the prerendered entry", async () => {
    const requests: Array<string> = [];
    const fetcher: SessionFetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(`${init?.method ?? "GET"} ${url}`);
      return init?.method === "POST"
        ? jsonResponse({
            authenticated: true,
            playerId: "player-1",
            nickname: "Alpha",
            skinId: 1,
            expiresAt: 1_700_000_000_000,
          })
        : jsonResponse(descriptor);
    };
    const store = new SessionStore({ status: "anonymous", descriptor: undefined }, fetcher);

    await expect(store.login("Alpha", 1)).resolves.toBeUndefined();
    expect(requests).toEqual(["GET /api/game", "POST /api/session"]);
    expect(store.state).toEqual({
      status: "authenticated",
      descriptor,
      session: {
        authenticated: true,
        playerId: "player-1",
        nickname: "Alpha",
        skinId: 1,
        expiresAt: 1_700_000_000_000,
      },
    });
  });

  it("ends an authenticated session with unload-safe delivery", async () => {
    let requestedUrl: string | undefined;
    let requestedMethod: string | undefined;
    let requestedKeepalive: boolean | undefined;
    const fetcher: SessionFetch = async (input, init) => {
      requestedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requestedMethod = init?.method;
      requestedKeepalive = init?.keepalive;
      return new Response(null, { status: 204 });
    };
    const store = new SessionStore(
      {
        status: "authenticated",
        descriptor,
        session: {
          authenticated: true,
          playerId: "player-1",
          nickname: "Alpha",
          skinId: 1,
          expiresAt: 1_700_000_000_000,
        },
      },
      fetcher,
    );

    await store.endSession(true);

    expect(requestedUrl).toBe(descriptor.sessionPath);
    expect(requestedMethod).toBe("DELETE");
    expect(requestedKeepalive).toBe(true);
    expect(store.state).toEqual({ status: "anonymous", descriptor });
  });
});

describe("session rate-limit messages", () => {
  it("uses the server-provided retry delay instead of a fixed minute", () => {
    expect(sessionErrorMessage("RATE_LIMITED", "12", 0)).toBe("尝试太频繁了，请 12 秒后再试");
  });

  it("accepts an HTTP-date Retry-After value", () => {
    const now = 1_700_000_000_000;
    expect(sessionErrorMessage("RATE_LIMITED", new Date(now + 5000).toUTCString(), now)).toBe(
      "尝试太频繁了，请 5 秒后再试",
    );
  });

  it("falls back safely when the retry header is missing or malformed", () => {
    expect(sessionErrorMessage("RATE_LIMITED", null, 0)).toBe("尝试太频繁了，请稍后再试");
    expect(sessionErrorMessage("RATE_LIMITED", "not-a-delay", 0)).toBe("尝试太频繁了，请稍后再试");
  });
});
