import { Effect } from "effect";
import { readBoundedJson } from "../../http/bounded-json";
import { AccessAttemptLimiter } from "../attempt-limiter";
import { parseAccessKeyRegistry } from "../registry";
import { SessionClaims, signSession, verifySession } from "../session";

export interface AccessScenario {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export const accessScenarios: ReadonlyArray<AccessScenario> = [
  {
    name: "access registry decodes hashes without exposing raw keys",
    run: async () => {
      const registry = await Effect.runPromise(
        parseAccessKeyRegistry(JSON.stringify([{ playerId: "friend-a", hash: "a".repeat(64) }])),
      );
      requireCondition(
        registry.get("a".repeat(64)) === "friend-a",
        "registry hash was not decoded",
      );
      requireCondition(!registry.has("0000"), "registry exposed an unexpected key");
    },
  },
  {
    name: "access registry rejects duplicate player identities",
    run: async () => {
      let rejected = false;
      try {
        await Effect.runPromise(
          parseAccessKeyRegistry(
            JSON.stringify([
              { playerId: "friend-a", hash: "a".repeat(64) },
              { playerId: "friend-a", hash: "b".repeat(64) },
            ]),
          ),
        );
      } catch {
        rejected = true;
      }
      requireCondition(rejected, "duplicate player identity was accepted");
    },
  },
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
    name: "friend key attempts are bounded per source window",
    run: () => {
      const limiter = new AccessAttemptLimiter(2, 1_000);
      requireCondition(limiter.allow("source-a", 0), "first attempt was blocked");
      requireCondition(limiter.allow("source-a", 100), "second attempt was blocked");
      requireCondition(!limiter.allow("source-a", 200), "excess attempt was accepted");
      requireCondition(limiter.allow("source-b", 200), "another source inherited the block");
      requireCondition(limiter.allow("source-a", 1_000), "expired window did not reset");
    },
  },
  {
    name: "session JSON bodies are bounded before decoding",
    run: async () => {
      const payload = await readBoundedJson(
        new Request("https://snake.example/api/session", {
          method: "POST",
          body: JSON.stringify({ key: "test", nickname: "Alpha" }),
        }),
        128,
      );
      requireCondition(JSON.stringify(payload).includes("Alpha"), "bounded JSON was not decoded");

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
