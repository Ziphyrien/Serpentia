import { describe, expect, it } from "vite-plus/test";
import { roomScenarios } from "./room-scenarios";

describe("friend game room controller", () => {
  for (const scenario of roomScenarios) {
    it(scenario.name, async () => {
      await expect(Promise.resolve().then(() => scenario.run())).resolves.not.toThrow();
    });
  }
});
