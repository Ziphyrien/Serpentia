import { describe, expect, it } from "vite-plus/test";

/** One named invariant that throws when the behaviour it guards regresses. */
export interface Scenario {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

export function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Runs every scenario as its own test so a failure reports the invariant by name. */
export function runScenarios(suite: string, scenarios: ReadonlyArray<Scenario>): void {
  describe(suite, () => {
    for (const scenario of scenarios) {
      it(scenario.name, async () => {
        await expect(Promise.resolve().then(() => scenario.run())).resolves.not.toThrow();
      });
    }
  });
}
