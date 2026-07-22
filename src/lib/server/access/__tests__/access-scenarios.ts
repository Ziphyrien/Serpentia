import { Effect } from "effect";
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
      requireCondition(registry.get("a".repeat(64)) === "friend-a", "registry hash was not decoded");
      requireCondition(!registry.has("0000"), "registry exposed an unexpected key");
    },
  },
  {
    name: "session tokens are signed, expiring, and tamper resistant",
    run: async () => {
      const claims = new SessionClaims({ playerId: "friend-a", nickname: "Alpha", expiresAt: 2_000 });
      const token = await signSession(claims, "test-session-secret");
      const verified = await verifySession(token, "test-session-secret", 1_000);
      requireCondition(verified?.playerId === "friend-a", "valid session was rejected");
      requireCondition((await verifySession(token, "wrong-secret", 1_000)) === undefined, "wrong secret verified session");
      const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
      requireCondition((await verifySession(tampered, "test-session-secret", 1_000)) === undefined, "tampered session verified");
      requireCondition((await verifySession(token, "test-session-secret", 2_000)) === undefined, "expired session verified");
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
];
