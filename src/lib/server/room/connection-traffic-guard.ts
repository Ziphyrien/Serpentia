import {
  MAX_INPUT_MESSAGES_PER_SECOND,
  MAX_TOTAL_MESSAGES_PER_SECOND,
  MAX_VOICE_SIGNALS_PER_SECOND,
} from "../../protocol/game";

export type MessageCategory = "input" | "voice-signal" | "control";

interface WindowCounter {
  startedAt: number;
  count: number;
}

interface ConnectionCounters {
  readonly total: WindowCounter;
  readonly input: WindowCounter;
  readonly voiceSignal: WindowCounter;
  invalidMessages: number;
}

const WINDOW_MILLISECONDS = 1_000;
const MAX_INVALID_MESSAGES = 3;

export class ConnectionTrafficGuard {
  private readonly counters = new Map<string, ConnectionCounters>();

  allow(connectionId: string, category: MessageCategory, now = Date.now()): boolean {
    return this.allowTotal(connectionId, now) && this.allowCategory(connectionId, category, now);
  }

  allowTotal(connectionId: string, now = Date.now()): boolean {
    return increment(this.getCounters(connectionId, now).total, MAX_TOTAL_MESSAGES_PER_SECOND, now);
  }

  allowCategory(connectionId: string, category: MessageCategory, now = Date.now()): boolean {
    const counters = this.getCounters(connectionId, now);
    if (category === "input") {
      return increment(counters.input, MAX_INPUT_MESSAGES_PER_SECOND, now);
    }
    if (category === "voice-signal") {
      return increment(counters.voiceSignal, MAX_VOICE_SIGNALS_PER_SECOND, now);
    }
    return true;
  }

  recordInvalid(connectionId: string, now = Date.now()): boolean {
    const counters = this.getCounters(connectionId, now);
    counters.invalidMessages += 1;
    return counters.invalidMessages >= MAX_INVALID_MESSAGES;
  }

  forget(connectionId: string): void {
    this.counters.delete(connectionId);
  }

  private getCounters(connectionId: string, now: number): ConnectionCounters {
    const current = this.counters.get(connectionId);
    if (current !== undefined) return current;
    const counters: ConnectionCounters = {
      total: { startedAt: now, count: 0 },
      input: { startedAt: now, count: 0 },
      voiceSignal: { startedAt: now, count: 0 },
      invalidMessages: 0,
    };
    this.counters.set(connectionId, counters);
    return counters;
  }
}

function increment(counter: WindowCounter, limit: number, now: number): boolean {
  if (now - counter.startedAt >= WINDOW_MILLISECONDS) {
    counter.startedAt = now;
    counter.count = 1;
    return true;
  }
  if (counter.count >= limit) return false;
  counter.count += 1;
  return true;
}
