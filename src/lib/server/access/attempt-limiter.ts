interface AttemptWindow {
  readonly startedAt: number;
  readonly count: number;
}

export class AccessAttemptLimiter {
  private readonly windows = new Map<string, AttemptWindow>();

  constructor(
    private readonly maximumAttempts = 5,
    private readonly windowMilliseconds = 60_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const current = this.windows.get(key);
    if (current === undefined || now - current.startedAt >= this.windowMilliseconds) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= this.maximumAttempts) return false;
    this.windows.set(key, { ...current, count: current.count + 1 });
    return true;
  }

  prune(now = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMilliseconds) this.windows.delete(key);
    }
  }
}
