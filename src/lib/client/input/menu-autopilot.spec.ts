import { describe, expect, it } from "vite-plus/test";
import type { FoodState, GameSnapshot, Point, SnakeSnapshot } from "$lib/protocol";
import { menuAutopilotCommand } from "./menu-autopilot";

function snake(
  id: string,
  head: Point,
  angle = 0,
  body: ReadonlyArray<Point> = [head],
): SnakeSnapshot {
  return {
    id,
    nickname: id,
    body: [...body],
    angle,
    targetAngle: angle,
    skinId: 1,
    bodyScale: 1,
    length: 80,
    score: 80,
    kills: 0,
    boosting: false,
    alive: true,
    invulnerable: false,
    magnetUntilSourceFrame: null,
    respawnAtTick: null,
    lastInputSequence: 0,
    lastInputAppliedTick: 0,
  };
}

function food(id: number, position: Point, value = 1): FoodState {
  return {
    id,
    position,
    value,
    lengthValue: value,
    variant: 0,
    generation: 0,
    kind: "ambient",
  };
}

function snapshot(
  snakes: ReadonlyArray<SnakeSnapshot>,
  foods: ReadonlyArray<FoodState> = [],
): GameSnapshot {
  return { tick: 1, snakes: [...snakes], foods: [...foods], magnets: [], leaderboard: [] };
}

describe("menu DWA/MPC trajectory planner", () => {
  it("turns inward before crossing the arena boundary", () => {
    const command = menuAutopilotCommand(
      snapshot([snake("self", { x: 2_300, y: 0 }, 0)]),
      "self",
      2_448,
    );

    expect(command).toBeDefined();
    expect(Math.cos(command?.angle ?? 0)).toBeLessThan(0);
    expect(command?.boosting).toBe(false);
  });

  it("steers away from another snake directly ahead", () => {
    const obstacleBody = Array.from({ length: 9 }, (_, index) => ({
      x: 140 + index * 45,
      y: 0,
    }));
    const command = menuAutopilotCommand(
      snapshot([
        snake("self", { x: 0, y: 0 }, 0),
        snake("other", obstacleBody[0] ?? { x: 140, y: 0 }, Math.PI, obstacleBody),
      ]),
      "self",
      2_448,
    );

    expect(command).toBeDefined();
    expect(Math.cos(command?.angle ?? 0)).toBeLessThan(0.9);
  });

  it("heads toward nearby food when the route is safe", () => {
    const command = menuAutopilotCommand(
      snapshot([snake("self", { x: 0, y: 0 }, 0)], [food(1, { x: 0, y: 500 }, 10)]),
      "self",
      2_448,
    );

    expect(command).toBeDefined();
    expect(Math.sin(command?.angle ?? 0)).toBeGreaterThan(0.7);
  });

  it("does not take over without a living local snake", () => {
    const self = { ...snake("self", { x: 0, y: 0 }), alive: false };
    expect(menuAutopilotCommand(snapshot([self]), "self", 2_448)).toBeUndefined();
    expect(menuAutopilotCommand(snapshot([]), undefined, 2_448)).toBeUndefined();
  });
});
