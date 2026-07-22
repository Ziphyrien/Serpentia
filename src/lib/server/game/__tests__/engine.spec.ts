import { describe, expect, it } from "vite-plus/test";
import { gameplayScenarios } from "./gameplay-scenarios";

describe("authoritative multiplayer game engine", () => {
  for (const scenario of gameplayScenarios) {
    it(scenario.name, async () => {
      await expect(Promise.resolve().then(() => scenario.run())).resolves.not.toThrow();
    });
  }
});
