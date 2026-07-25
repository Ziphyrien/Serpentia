import { turnTowards } from "../../../game/snake-motion";
import { GameEngine } from "../../game/engine";
import { gameConfig } from "../../game/__tests__/game-config";
import { ConnectionTrafficGuard } from "../connection-traffic-guard";
import { RoomController } from "../room-controller";

export interface RoomScenario {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export const roomScenarios: ReadonlyArray<RoomScenario> = [
  {
    name: "one session controls only one live snake connection",
    run: () => {
      const controller = new RoomController(new GameEngine(gameConfig(), 1, false));
      const first = controller.join("old", { playerId: "friend-a", nickname: "Alpha" });
      requireCondition(first._tag === "Accepted", "first connection was rejected");
      const result = controller.join("new", { playerId: "friend-a", nickname: "Alpha 2" });
      requireCondition(result._tag === "Accepted", "replacement connection was rejected");
      requireCondition(result.replacedConnectionId === "old", "old connection was not replaced");
      requireCondition(controller.connectionCount === 1, "duplicate connection remained active");
      requireCondition(controller.snapshot().snakes.length === 1, "duplicate snake was created");
      requireCondition(!controller.leave("old"), "stale close removed the replacement connection");
      requireCondition(controller.connectionCount === 1, "replacement connection was lost");
    },
  },
  {
    name: "connection identity owns authoritative input player id",
    run: () => {
      const controller = new RoomController(new GameEngine(gameConfig(), 1, false));
      const joined = controller.join("connection-a", {
        playerId: "friend-a",
        nickname: "Alpha",
      });
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
    },
  },
  {
    name: "scheduled input takes effect on its authoritative target tick",
    run: () => {
      const config = gameConfig();
      const controller = new RoomController(new GameEngine(config, 1, false));
      const joined = controller.join("connection-a", {
        playerId: "friend-a",
        nickname: "Alpha",
      });
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
            turnTowards(initialAngle, Math.PI / 2, config.turnRate / config.tickRate),
        ) < 0.000001,
        "scheduled input did not apply on its target tick",
      );
      requireCondition(
        controller.snapshot().snakes[0].lastInputAppliedTick === 3,
        "snapshot lost the applied input tick",
      );
    },
  },
  {
    name: "late input reports the authoritative tick where it actually applied",
    run: () => {
      const controller = new RoomController(new GameEngine(gameConfig(), 1, false));
      const joined = controller.join("connection-a", {
        playerId: "friend-a",
        nickname: "Alpha",
      });
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
    },
  },
  {
    name: "newest sequence wins when multiple inputs target one tick",
    run: () => {
      const controller = new RoomController(new GameEngine(gameConfig(), 1, false));
      const joined = controller.join("connection-a", {
        playerId: "friend-a",
        nickname: "Alpha",
      });
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
    },
  },
  {
    name: "nicknames are unique after Unicode and case normalization",
    run: () => {
      const controller = new RoomController(new GameEngine(gameConfig(), 1, false));
      const first = controller.join("connection-a", {
        playerId: "friend-a",
        nickname: "Alpha",
      });
      const duplicate = controller.join("connection-b", {
        playerId: "friend-b",
        nickname: "ＡLPHA",
      });
      requireCondition(first._tag === "Accepted", "first nickname was rejected");
      requireCondition(duplicate._tag === "Rejected", "duplicate nickname was accepted");
      requireCondition(duplicate.reason === "NICKNAME_IN_USE", "wrong rejection reason");
    },
  },
  {
    name: "reconnect grace resumes the same snake and input sequence",
    run: () => {
      const controller = new RoomController(new GameEngine(gameConfig(), 1, false), 3);
      const joined = controller.join("old", { playerId: "friend-a", nickname: "Alpha" });
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

      const resumed = controller.join("new", { playerId: "friend-a", nickname: "Alpha" });
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
    },
  },
  {
    name: "disconnected snakes expire after the reconnect grace",
    run: () => {
      const controller = new RoomController(new GameEngine(gameConfig(), 1, false), 2);
      const joined = controller.join("connection-a", {
        playerId: "friend-a",
        nickname: "Alpha",
      });
      requireCondition(joined._tag === "Accepted", "connection was rejected");
      requireCondition(controller.leave("connection-a"), "disconnect was ignored");
      requireCondition(controller.shouldRun, "room stopped before reconnect grace elapsed");
      controller.tick();
      requireCondition(controller.snapshot().snakes.length === 1, "snake expired too early");
      controller.tick();
      requireCondition(controller.snapshot().snakes.length === 0, "snake did not expire");
      requireCondition(!controller.shouldRun, "empty room simulation remained active");
    },
  },
  {
    name: "target tick claims outside the authoritative window are rejected",
    run: () => {
      const config = gameConfig();
      const controller = new RoomController(new GameEngine(config, 1, false));
      const joined = controller.join("connection-a", {
        playerId: "friend-a",
        nickname: "Alpha",
      });
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
    },
  },
  {
    name: "per-connection traffic guard bounds input and malformed messages",
    run: () => {
      const guard = new ConnectionTrafficGuard();
      for (let index = 0; index < 40; index += 1) {
        requireCondition(guard.allow("connection-a", "input", 0), "valid input rate was blocked");
      }
      requireCondition(!guard.allow("connection-a", "input", 0), "excess input rate was accepted");
      requireCondition(guard.allow("connection-a", "input", 1_000), "input window did not reset");
      requireCondition(
        !guard.recordInvalid("connection-b", 0),
        "first invalid message closed early",
      );
      requireCondition(
        !guard.recordInvalid("connection-b", 0),
        "second invalid message closed early",
      );
      requireCondition(
        guard.recordInvalid("connection-b", 0),
        "invalid message limit was not enforced",
      );
    },
  },
];
