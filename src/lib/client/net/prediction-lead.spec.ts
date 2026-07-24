import { describe, expect, it } from "vite-plus/test";
import { PredictionLeadEstimator } from "./prediction-lead";

describe("prediction lead estimator", () => {
  it("keeps stable production-like latency at the two-tick floor", () => {
    const estimator = new PredictionLeadEstimator();
    for (const rtt of [46, 48, 47, 45, 49, 46, 47, 48]) estimator.addRttSample(rtt);
    expect(estimator.leadTicks(20)).toBe(2);
  });

  it("uses a third tick when p95 jitter consumes the safety window", () => {
    const estimator = new PredictionLeadEstimator();
    for (const rtt of [46, 47, 45, 48, 46, 115, 47, 46]) estimator.addRttSample(rtt);
    expect(estimator.leadTicks(20)).toBe(3);
  });

  it("bounds extreme latency and ignores invalid samples", () => {
    const estimator = new PredictionLeadEstimator();
    estimator.addRttSample(Number.NaN);
    estimator.addRttSample(-1);
    expect(estimator.leadTicks(20)).toBe(2);
    estimator.addRttSample(1_000);
    expect(estimator.leadTicks(20)).toBe(3);
  });
});
