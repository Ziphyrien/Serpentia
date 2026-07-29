export interface AttemptDecision {
  readonly allowed: boolean;
  readonly retryAfterMilliseconds: number;
}

interface AttemptBucket {
  readonly tokens: number;
  readonly updatedAt: number;
}

/**
 * 带突发容量的令牌桶。
 *
 * `maximumAttempts` 是桶容量，`windowMilliseconds` 内持续补满一整桶；因此长期平均
 * 速率与原固定窗口相同，但耗尽后只需等待一个令牌，而不是等整个窗口结束。
 */
export class AttemptLimiter {
  private readonly buckets = new Map<string, AttemptBucket>();
  private lastPrunedAt = 0;

  constructor(
    private readonly maximumAttempts = 5,
    private readonly windowMilliseconds = 60_000,
  ) {}

  take(key: string, now = Date.now()): AttemptDecision {
    if (now - this.lastPrunedAt >= this.windowMilliseconds) this.prune(now);

    const current = this.buckets.get(key);
    const updatedAt = current === undefined ? now : Math.max(now, current.updatedAt);
    const elapsed = current === undefined ? 0 : Math.max(0, now - current.updatedAt);
    const refillRate = this.maximumAttempts / this.windowMilliseconds;
    const tokens = Math.min(
      this.maximumAttempts,
      (current?.tokens ?? this.maximumAttempts) + elapsed * refillRate,
    );

    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, updatedAt });
      return { allowed: true, retryAfterMilliseconds: 0 };
    }

    this.buckets.set(key, { tokens, updatedAt });
    return {
      allowed: false,
      retryAfterMilliseconds: Math.ceil((1 - tokens) / refillRate),
    };
  }

  allow(key: string, now = Date.now()): boolean {
    return this.take(key, now).allowed;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= this.windowMilliseconds) this.buckets.delete(key);
    }
    this.lastPrunedAt = now;
  }
}
