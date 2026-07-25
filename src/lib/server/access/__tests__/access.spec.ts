import { describe, expect, it } from "vite-plus/test";
import { sessionScenarios } from "./access-scenarios";

describe("sessions", () => {
  for (const scenario of sessionScenarios) {
    it(scenario.name, async () => {
      await expect(Promise.resolve().then(() => scenario.run())).resolves.not.toThrow();
    });
  }
});
