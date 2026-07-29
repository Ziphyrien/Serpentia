import { expect } from "vite-plus/test";

export function requireCondition(condition: boolean, message: string): asserts condition {
  expect(condition, message).toBe(true);
}
