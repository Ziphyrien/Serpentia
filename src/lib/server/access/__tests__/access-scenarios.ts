import { Schema } from "effect";
import { SessionInfo, SessionRequest } from "../../../protocol";
import { readBoundedJson } from "../../http/bounded-json";
import { ApiRouter } from "../../http/api-router";
import { createBackendDescriptor, createRoomMetadata } from "../../room/room-settings";
import { loadRuntimeConfig } from "../../runtime/config";
import { RuntimeServices } from "../../runtime/services";
import { AttemptLimiter } from "../attempt-limiter";
import { SessionClaims, signSession, verifySession } from "../session";

export interface SessionScenario {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export const sessionScenarios: ReadonlyArray<SessionScenario> = [
  {
    name: "session tokens are signed, expiring, and tamper resistant",
    run: async () => {
      const claims = SessionClaims.make({
        playerId: "friend-a",
        nickname: "Alpha",
        expiresAt: 2_000,
      });
      const secret = "test-session-signing-secret-at-least-32-characters";
      const token = await signSession(claims, secret);
      const verified = await verifySession(token, secret, 1_000);
      requireCondition(verified?.playerId === "friend-a", "valid session was rejected");
      requireCondition(
        (await verifySession(
          token,
          "wrong-session-signing-secret-at-least-32-characters",
          1_000,
        )) === undefined,
        "wrong secret verified session",
      );
      const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
      requireCondition(
        (await verifySession(tampered, secret, 1_000)) === undefined,
        "tampered session verified",
      );
      requireCondition(
        (await verifySession(token, secret, 2_000)) === undefined,
        "expired session verified",
      );
    },
  },
  {
    name: "a nickname alone creates a signed session with a generated player ID",
    run: async () => {
      const room = createRoomMetadata([]);
      const services = new RuntimeServices(room);
      try {
        const config = loadRuntimeConfig({
          NODE_ENV: "development",
          SESSION_SIGNING_SECRET: "test-session-signing-secret-at-least-32-characters",
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
        requireCondition(
          response.headers.get("set-cookie")?.includes("serpentia_session=") === true,
          "session cookie was not set",
        );
      } finally {
        services.dispose();
      }
    },
  },
  {
    name: "session attempts are bounded per source window",
    run: () => {
      const limiter = new AttemptLimiter(2, 1_000);
      requireCondition(limiter.allow("source-a", 0), "first attempt was blocked");
      requireCondition(limiter.allow("source-a", 100), "second attempt was blocked");
      requireCondition(!limiter.allow("source-a", 200), "excess attempt was accepted");
      requireCondition(limiter.allow("source-b", 200), "another source inherited the block");
      requireCondition(limiter.allow("source-a", 1_000), "expired window did not reset");
    },
  },
  {
    name: "session requests require only a nickname and bound the JSON body",
    run: async () => {
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
    },
  },
];
