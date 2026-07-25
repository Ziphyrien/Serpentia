const DEFAULT_SAFETY_MARGIN_MS = 25;
const MAX_RTT_SAMPLES = 32;

/** Rolling network-quality estimate used only when starting a prediction phase. */
export class PredictionLeadEstimator {
  private readonly samples: Array<number> = [];

  constructor(private readonly safetyMarginMs = DEFAULT_SAFETY_MARGIN_MS) {}

  addRttSample(rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0) return;
    this.samples.push(rttMs);
    if (this.samples.length > MAX_RTT_SAMPLES) this.samples.shift();
  }

  leadTicks(tickRate: number): number {
    if (!Number.isFinite(tickRate) || tickRate <= 0 || this.samples.length === 0) return 2;
    const medianRtt = percentile(this.samples, 0.5);
    const jitter = this.samples.map((sample) => Math.abs(sample - medianRtt));
    const jitterP95 = percentile(jitter, 0.95);
    const tickMs = 1000 / tickRate;
    const required = Math.ceil((medianRtt / 2 + jitterP95 + this.safetyMarginMs) / tickMs);
    return Math.min(3, Math.max(2, required));
  }
}

function percentile(values: ReadonlyArray<number>, fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((sorted.length - 1) * fraction);
  return sorted[index];
}
