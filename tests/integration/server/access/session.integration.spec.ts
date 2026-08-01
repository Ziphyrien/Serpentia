import { describe, it } from "vite-plus/test";
import { Schema } from "effect";
import { DEFAULT_SKIN_ID } from "$lib/game/internal-skins";
import { SessionInfo, SessionRequest } from "$lib/protocol";
import { AttemptLimiter } from "$lib/server/access/attempt-limiter";
import { SessionClaims, signSession, verifySession } from "$lib/server/access/session";
import { ApiRouter } from "$lib/server/http/api-router";
import { readBoundedJson } from "$lib/server/http/bounded-json";
import { createBackendDescriptor, createRoomMetadata } from "$lib/server/room/room-settings";
import { loadRuntimeConfig } from "$lib/server/runtime/config";
import { RuntimeServices } from "$lib/server/runtime/services";
import { requireCondition } from "../../../support/assertions";
describe("sessions", () => {
  it("session tokens are signed, expiring, and tamper resistant", async () => {
    const claims = SessionClaims.make({
      playerId: "friend-a",
      nickname: "Alpha",
      skinId: DEFAULT_SKIN_ID,
      expiresAt: 2000,
    });
    const secret = "test-session-signing-secret-at-least-32-characters";
    const token = await signSession(claims, secret);
    const verified = await verifySession(token, secret, 1000);
    requireCondition(verified?.playerId === "friend-a", "valid session was rejected");
    requireCondition(verified?.skinId === DEFAULT_SKIN_ID, "session skin was changed");
    requireCondition(
      (await verifySession(token, "wrong-session-signing-secret-at-least-32-characters", 1000)) ===
        undefined,
      "wrong secret verified session",
    );
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    requireCondition(
      (await verifySession(tampered, secret, 1000)) === undefined,
      "tampered session verified",
    );
    requireCondition(
      (await verifySession(token, secret, 2000)) === undefined,
      "expired session verified",
    );
  });
  it("a nickname alone creates a signed session with a generated player ID", async () => {
    const room = createRoomMetadata([]);
    const services = new RuntimeServices(room);
    try {
      const config = loadRuntimeConfig({
        NODE_ENV: "development",
        SESSION_SIGNING_SECRET: "test-session-signing-secret-at-least-32-characters",
        BILIBILI_COOKIE:
          "SESSDATA=fake-session; bili_jct=0123456789abcdef0123456789abcdef",
        BILIBILI_REFRESH_TOKEN: "0123456789abcdef0123456789abcdef",
      });
      const router = new ApiRouter(config, services, createBackendDescriptor(room));
      const response = await router.handle(
        new Request("http://snake.example/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nickname: "Alpha" }),
        }),
        "127.0.0.1",
      );
      requireCondition(response?.status === 200, "nickname-only login was rejected");
      const session = await Schema.decodeUnknownPromise(SessionInfo)(await response.json());
      requireCondition(session.nickname === "Alpha", "session changed the nickname");
      requireCondition(session.skinId === DEFAULT_SKIN_ID, "session used the wrong default skin");
      requireCondition(
        response.headers.get("set-cookie")?.includes("serpentia_session=") === true,
        "session cookie was not set",
      );
    } finally {
      await services.dispose();
    }
  });
  it("returns the token bucket retry delay on excess session requests", async () => {
    const room = createRoomMetadata([]);
    const services = new RuntimeServices(room);
    try {
      const config = loadRuntimeConfig({
        NODE_ENV: "development",
        SESSION_SIGNING_SECRET: "test-session-signing-secret-at-least-32-characters",
        BILIBILI_COOKIE:
          "SESSDATA=fake-session; bili_jct=0123456789abcdef0123456789abcdef",
        BILIBILI_REFRESH_TOKEN: "0123456789abcdef0123456789abcdef",
      });
      const router = new ApiRouter(config, services, createBackendDescriptor(room));
      let response: Response | undefined;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        response = await router.handle(
          new Request("http://snake.example/api/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ nickname: `Alpha-${attempt}` }),
          }),
          "127.0.0.2",
        );
      }

      requireCondition(response?.status === 429, "excess session attempt was accepted");
      const retryAfter = Number(response.headers.get("retry-after"));
      requireCondition(
        Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 12,
        "session retry delay did not match token refill time",
      );
    } finally {
      await services.dispose();
    }
  });
  it("session attempts are bounded per-source by a token bucket", () => {
    const limiter = new AttemptLimiter(2, 1000);
    requireCondition(limiter.allow("source-a", 0), "first attempt was blocked");
    requireCondition(limiter.allow("source-a", 100), "second attempt was blocked");
    requireCondition(!limiter.allow("source-a", 200), "excess attempt was accepted");
    requireCondition(limiter.allow("source-b", 200), "another source inherited the block");
    requireCondition(limiter.allow("source-a", 1000), "refilled bucket did not allow an attempt");
  });
  it("session requests require only a nickname and bound the JSON body", async () => {
    const payload = await readBoundedJson(
      new Request("https://snake.example/api/session", {
        method: "POST",
        body: JSON.stringify({ nickname: "Alpha" }),
      }),
      128,
    );
    const input = await Schema.decodeUnknownPromise(SessionRequest)(payload);
    requireCondition(input.nickname === "Alpha", "nickname-only session request was rejected");
    let rejected = false;
    try {
      await readBoundedJson(
        new Request("https://snake.example/api/session", {
          method: "POST",
          body: "x".repeat(129),
        }),
        128,
      );
    } catch {
      rejected = true;
    }
    requireCondition(rejected, "oversized session body was accepted");
  });
});
