import { describe, expect, it } from "vite-plus/test";
import { voiceScenarios } from "./voice-scenarios";

describe("friend room voice state", () => {
  for (const scenario of voiceScenarios) {
    it(scenario.name, async () => {
      await expect(Promise.resolve().then(() => scenario.run())).resolves.not.toThrow();
    });
  }
});
