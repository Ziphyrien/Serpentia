import { describe, expect, it } from "vite-plus/test";
import { accessScenarios } from "./access-scenarios";

describe("friend access session", () => {
  for (const scenario of accessScenarios) {
    it(scenario.name, async () => {
      await expect(Promise.resolve().then(() => scenario.run())).resolves.not.toThrow();
    });
  }
});
