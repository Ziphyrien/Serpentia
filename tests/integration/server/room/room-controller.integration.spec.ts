import { describe, it } from "vite-plus/test";
import { DEFAULT_SKIN_ID } from "$lib/game/internal-skins";
import { turnTowards } from "$lib/game/snake-motion";
import { motionRulesFor, type GameConfig } from "$lib/server/game/config";
import { GameEngine } from "$lib/server/game/engine";
import { ConnectionTrafficGuard } from "$lib/server/room/connection-traffic-guard";
import { RoomController } from "$lib/server/room/room-controller";
import { gameConfig } from "../../../fixtures/server/game-config";
import { requireCondition } from "../../../support/assertions";
/** 一个权威 tick 内按源帧逐步转向，因此上限是每帧转角乘子帧数。 */
function expectedAngleAfterOneTick(from: number, target: number, config: GameConfig): number {
  const motion = motionRulesFor(config);
  let angle = from;
  for (let frame = 0; frame < motion.sourceFramesPerTick; frame += 1) {
    angle = turnTowards(angle, target, motion.turnPerFrame);
  }
  return angle;
}
function playerIdentity(playerId: string, nickname: string) {
  return { playerId, nickname, skinId: DEFAULT_SKIN_ID };
}
describe("friend game room controller", () => {
  it("one session controls only one live snake connection", () => {
    const controller = new RoomController(new GameEngine(gameConfig(), 1, false));
    const first = controller.join("old", playerIdentity("friend-a", "Alpha"));
    requireCondition(first._tag === "Accepted", "first connection was rejected");
    const result = controller.join("new", playerIdentity("friend-a", "Alpha 2"));
    requireCondition(result._tag === "Accepted", "replacement connection was rejected");
    requireCondition(result.replacedConnectionId === "old", "old connection was not replaced");
    requireCondition(controller.connectionCount === 1, "duplicate connection remained active");
    requireCondition(controller.snapshot().snakes.length === 1, "duplicate snake was created");
    requireCondition(!controller.leave("old"), "stale close removed the replacement connection");
    requireCondition(controller.connectionCount === 1, "replacement connection was lost");
  });
  it("gives a fresh human player the original three-second protection", () => {
    const config = gameConfig({ arenaHalfSize: 100_000, spawnClearance: 2_000 });
    const controller = new RoomController(new GameEngine(config, 1, false));
    const joined = controller.join("connection-a", playerIdentity("friend-a", "Alpha"));
    requireCondition(joined._tag === "Accepted", "connection was rejected");
    requireCondition(
      joined.snapshot.snakes[0]?.invulnerable === true,
      "fresh player did not receive spawn protection",
    );

    for (let tick = 1; tick < config.initialInvulnerabilityTicks; tick += 1) {
      controller.tick();
    }
    requireCondition(
      controller.snapshot().snakes[0]?.invulnerable === true,
      "spawn protection ended before its final source frame",
    );
    controller.tick();
    requireCondition(
      controller.snapshot().snakes[0]?.invulnerable === false,
      "spawn protection remained after three seconds",
    );
  });
  it("connection identity owns authoritative input player id", () => {
    const config = gameConfig({ initialLength: 81 });
    const controller = new RoomController(new GameEngine(config, 1, false));
    const joined = controller.join("connection-a", playerIdentity("friend-a", "Alpha"));
    requireCondition(joined._tag === "Accepted", "connection was rejected");
    requireCondition(
      controller.applyInput("connection-a", {
        sequence: 1,
        targetTick: 1,
        angle: Math.PI / 2,
        boosting: true,
      }) !== false,
      "authorized input was rejected",
    );
    requireCondition(
      !controller.applyInput("unknown", {
        sequence: 2,
        targetTick: 1,
        angle: 0,
        boosting: true,
      }),
      "unknown connection injected input",
    );
    controller.tick();
    const snapshot = controller.snapshot();
    const snake = snapshot.snakes[0];
    requireCondition(snapshot.snakes.length === 1, "unexpected snake count");
    requireCondition(snake.id === "friend-a", "connection spoofed player identity");
    requireCondition(snake.boosting, "authorized boost input was not applied");
    requireCondition(snake.lastInputSequence === 1, "input acknowledgement was not exposed");
  });
  it("scheduled input takes effect on its authoritative target tick", () => {
    const config = gameConfig();
    const controller = new RoomController(new GameEngine(config, 1, false));
    const joined = controller.join("connection-a", playerIdentity("friend-a", "Alpha"));
    requireCondition(joined._tag === "Accepted", "connection was rejected");
    const initialAngle = joined.snapshot.snakes[0].angle;
    const accepted = controller.applyInput("connection-a", {
      sequence: 1,
      targetTick: 3,
      angle: Math.PI / 2,
      boosting: false,
    });
    requireCondition(accepted !== false, "scheduled input was rejected");
    requireCondition(accepted.targetTick === 3, "wrong target tick was acknowledged");
    const firstTick = controller.tick();
    const secondTick = controller.tick();
    requireCondition(firstTick.appliedInputs.length === 0, "input was acknowledged too early");
    requireCondition(secondTick.appliedInputs.length === 0, "input was acknowledged too early");
    requireCondition(
      Math.abs(controller.snapshot().snakes[0].angle - initialAngle) < 0.000001,
      "scheduled input applied before its target tick",
    );
    const targetTick = controller.tick();
    requireCondition(targetTick.appliedInputs.length === 1, "applied input was not acknowledged");
    requireCondition(
      targetTick.appliedInputs[0].sequence === 1 &&
        targetTick.appliedInputs[0].targetTick === 3 &&
        targetTick.appliedInputs[0].appliedTick === 3,
      "input acknowledgement did not preserve its tick timeline",
    );
    requireCondition(
      Math.abs(
        controller.snapshot().snakes[0].angle -
          expectedAngleAfterOneTick(initialAngle, Math.PI / 2, config),
      ) < 0.000001,
      "scheduled input did not apply on its target tick",
    );
    requireCondition(
      controller.snapshot().snakes[0].lastInputAppliedTick === 3,
      "snapshot lost the applied input tick",
    );
  });
  it("late input reports the authoritative tick where it actually applied", () => {
    const controller = new RoomController(new GameEngine(gameConfig(), 1, false));
    const joined = controller.join("connection-a", playerIdentity("friend-a", "Alpha"));
    requireCondition(joined._tag === "Accepted", "connection was rejected");
    controller.tick();
    controller.tick();
    controller.tick();
    const accepted = controller.applyInput("connection-a", {
      sequence: 1,
      targetTick: 2,
      angle: Math.PI / 2,
      boosting: true,
    });
    requireCondition(accepted !== false, "late input was rejected");
    requireCondition(accepted.targetTick === 2, "late input lost its requested tick");
    requireCondition(accepted.appliedTick === 4, "late input was not moved to the next tick");
    const result = controller.tick();
    requireCondition(result.appliedInputs.length === 1, "late input was not acknowledged");
    requireCondition(
      result.appliedInputs[0].targetTick === 2 && result.appliedInputs[0].appliedTick === 4,
      "late input acknowledgement hid the reschedule",
    );
    const snake = controller.snapshot().snakes[0];
    requireCondition(snake.lastInputSequence === 1, "late input did not apply");
    requireCondition(snake.lastInputAppliedTick === 4, "late input tick was not stored");
  });
  it("newest sequence wins when multiple inputs target one tick", () => {
    const config = gameConfig({ initialLength: 81 });
    const controller = new RoomController(new GameEngine(config, 1, false));
    const joined = controller.join("connection-a", playerIdentity("friend-a", "Alpha"));
    requireCondition(joined._tag === "Accepted", "connection was rejected");
    requireCondition(
      controller.applyInput("connection-a", {
        sequence: 1,
        targetTick: 2,
        angle: 0,
        boosting: false,
      }) !== false,
      "first input was rejected",
    );
    requireCondition(
      controller.applyInput("connection-a", {
        sequence: 2,
        targetTick: 2,
        angle: Math.PI,
        boosting: true,
      }) !== false,
      "replacement input was rejected",
    );
    controller.tick();
    const result = controller.tick();
    requireCondition(result.appliedInputs.length === 2, "wrong acknowledgement count");
    requireCondition(
      result.appliedInputs[0].sequence === 1 && result.appliedInputs[1].sequence === 2,
      "same-tick inputs were not acknowledged in sequence order",
    );
    const snake = controller.snapshot().snakes[0];
    requireCondition(snake.lastInputSequence === 2, "newest input did not apply");
    requireCondition(snake.boosting, "newest boost state did not apply");
  });
  it("nicknames are unique after Unicode and case normalization", () => {
    const controller = new RoomController(new GameEngine(gameConfig(), 1, false));
    const first = controller.join("connection-a", playerIdentity("friend-a", "Alpha"));
    const duplicate = controller.join("connection-b", playerIdentity("friend-b", "ＡLPHA"));
    requireCondition(first._tag === "Accepted", "first nickname was rejected");
    requireCondition(duplicate._tag === "Rejected", "duplicate nickname was accepted");
    requireCondition(duplicate.reason === "NICKNAME_IN_USE", "wrong rejection reason");
  });
  it("signing out frees the nickname regardless of socket close order", () => {
    for (const disconnectFirst of [false, true]) {
      const controller = new RoomController(new GameEngine(gameConfig(), 1, false), 100);
      const first = controller.join("connection-a", playerIdentity("session-1", "Alpha"));
      requireCondition(first._tag === "Accepted", "first connection was rejected");
      if (disconnectFirst) requireCondition(controller.leave("connection-a"), "close was ignored");
      requireCondition(controller.release("session-1"), "sign-out did not release the player");
      const rejoined = controller.join("connection-b", playerIdentity("session-2", "Alpha"));
      requireCondition(
        rejoined._tag === "Accepted",
        "nickname stayed locked to the signed-out session",
      );
      requireCondition(!controller.leave("connection-a"), "stale close affected the new player");
      requireCondition(controller.snapshot().snakes.length === 1, "signed-out snake lingered");
    }
  });
  it("reconnect grace resumes the same snake and input sequence", () => {
    const config = gameConfig({ initialInvulnerabilityTicks: 1 });
    const controller = new RoomController(new GameEngine(config, 1, false), 3);
    const joined = controller.join("old", playerIdentity("friend-a", "Alpha"));
    requireCondition(joined._tag === "Accepted", "initial connection was rejected");
    requireCondition(
      controller.applyInput("old", {
        sequence: 7,
        targetTick: 1,
        angle: 0,
        boosting: true,
      }) !== false,
      "initial input was rejected",
    );
    controller.tick();
    requireCondition(controller.leave("old"), "disconnect was ignored");
    controller.tick();
    const resumed = controller.join("new", playerIdentity("friend-a", "Alpha"));
    requireCondition(resumed._tag === "Accepted", "reconnect was rejected");
    requireCondition(resumed.resumed, "reconnect created a fresh snake");
    requireCondition(resumed.snapshot.snakes.length === 1, "reconnect duplicated the snake");
    requireCondition(
      resumed.snapshot.snakes[0].lastInputSequence === 7,
      "reconnect lost the authoritative input sequence",
    );
    requireCondition(
      resumed.snapshot.snakes[0].lastInputAppliedTick === 1,
      "reconnect lost the authoritative input tick",
    );
    requireCondition(
      !resumed.snapshot.snakes[0].invulnerable,
      "reconnect incorrectly refreshed spawn protection",
    );
  });
  it("disconnected snakes expire after the reconnect grace", () => {
    const controller = new RoomController(new GameEngine(gameConfig(), 1, false), 2);
    const joined = controller.join("connection-a", playerIdentity("friend-a", "Alpha"));
    requireCondition(joined._tag === "Accepted", "connection was rejected");
    requireCondition(controller.leave("connection-a"), "disconnect was ignored");
    requireCondition(controller.shouldRun, "room stopped before reconnect grace elapsed");
    controller.tick();
    requireCondition(controller.snapshot().snakes.length === 1, "snake expired too early");
    controller.tick();
    requireCondition(controller.snapshot().snakes.length === 0, "snake did not expire");
    requireCondition(!controller.shouldRun, "empty room simulation remained active");
  });
  it("target tick claims outside the authoritative window are rejected", () => {
    const config = gameConfig();
    const controller = new RoomController(new GameEngine(config, 1, false));
    const joined = controller.join("connection-a", playerIdentity("friend-a", "Alpha"));
    requireCondition(joined._tag === "Accepted", "connection was rejected");
    requireCondition(
      !controller.applyInput("connection-a", {
        sequence: 1,
        targetTick: config.tickRate * 2 + 1,
        angle: 0,
        boosting: false,
      }),
      "future target tick was accepted",
    );
    requireCondition(
      controller.applyInput("connection-a", {
        sequence: 1,
        targetTick: 1,
        angle: 0,
        boosting: false,
      }) !== false,
      "current target tick was rejected",
    );
  });
  it("per-connection traffic guard bounds input and malformed messages", () => {
    const guard = new ConnectionTrafficGuard();
    for (let index = 0; index < 40; index += 1) {
      requireCondition(guard.allow("connection-a", "input", 0), "valid input rate was blocked");
    }
    requireCondition(!guard.allow("connection-a", "input", 0), "excess input rate was accepted");
    requireCondition(guard.allow("connection-a", "input", 1000), "input window did not reset");
    requireCondition(!guard.recordInvalid("connection-b", 0), "first invalid message closed early");
    requireCondition(
      !guard.recordInvalid("connection-b", 0),
      "second invalid message closed early",
    );
    requireCondition(
      guard.recordInvalid("connection-b", 0),
      "invalid message limit was not enforced",
    );
  });
});
