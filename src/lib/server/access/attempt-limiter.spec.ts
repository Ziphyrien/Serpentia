import { describe, expect, it } from "vite-plus/test";
import { AttemptLimiter } from "./attempt-limiter";

describe("attempt limiter token bucket", () => {
  it("allows a configured burst and reports the exact next-token delay", () => {
    const limiter = new AttemptLimiter(2, 1000);

    expect(limiter.take("source", 0)).toEqual({
      allowed: true,
      retryAfterMilliseconds: 0,
    });
    expect(limiter.take("source", 0)).toEqual({
      allowed: true,
      retryAfterMilliseconds: 0,
    });
    expect(limiter.take("source", 0)).toEqual({
      allowed: false,
      retryAfterMilliseconds: 500,
    });
    expect(limiter.take("source", 200)).toEqual({
      allowed: false,
      retryAfterMilliseconds: 300,
    });
  });

  it("restores one attempt at a time instead of resetting the whole window", () => {
    const limiter = new AttemptLimiter(2, 1000);
    expect(limiter.allow("source", 0)).toBe(true);
    expect(limiter.allow("source", 0)).toBe(true);

    expect(limiter.allow("source", 499)).toBe(false);
    expect(limiter.allow("source", 500)).toBe(true);
    expect(limiter.allow("source", 500)).toBe(false);
    expect(limiter.allow("source", 1000)).toBe(true);
  });

  it("isolates buckets by source", () => {
    const limiter = new AttemptLimiter(1, 1000);
    expect(limiter.allow("source-a", 0)).toBe(true);
    expect(limiter.allow("source-a", 1)).toBe(false);
    expect(limiter.allow("source-b", 1)).toBe(true);
  });
});
