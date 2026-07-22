import { GameEngine } from "../../game/engine";
import { gameConfig } from "../../game/__tests__/game-config";
import { encodeNicknameHeader, readPlayerIdentity } from "../connection-identity";
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
    name: "one access key controls only one live snake connection",
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
          clientTick: 0,
          angle: Math.PI / 2,
          boosting: true,
        }),
        "authorized input was rejected",
      );
      requireCondition(
        !controller.applyInput("unknown", {
          sequence: 2,
          clientTick: 0,
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
    name: "PartyServer ingress accepts a bounded trusted player identity",
    run: () => {
      const identity = readPlayerIdentity(
        new Request("https://snake.example/api/parties/game-room/friends", {
          headers: {
            "x-serpentia-player-id": "friend-a",
            "x-serpentia-nickname": encodeNicknameHeader("  Alpha   Friend  "),
            "x-serpentia-session-expires-at": "2000",
          },
        }),
        1000,
      );
      requireCondition(identity !== undefined, "valid identity was rejected");
      requireCondition(identity.playerId === "friend-a", "player id changed");
      requireCondition(identity.nickname === "Alpha Friend", "nickname was not normalized");
    },
  },
  {
    name: "PartyServer ingress rejects missing or unsafe player identity",
    run: () => {
      requireCondition(
        readPlayerIdentity(new Request("https://snake.example")) === undefined,
        "missing identity was accepted",
      );
      requireCondition(
        readPlayerIdentity(
          new Request("https://snake.example", {
            headers: {
              "x-serpentia-player-id": "friend-a",
              "x-serpentia-nickname": "A".repeat(25),
            },
          }),
        ) === undefined,
        "unsafe nickname was accepted",
      );
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
          clientTick: 0,
          angle: 0,
          boosting: true,
        }),
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
    name: "client tick claims outside the authoritative window are rejected",
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
          clientTick: config.tickRate * 2 + 1,
          angle: 0,
          boosting: false,
        }),
        "future client tick was accepted",
      );
      requireCondition(
        controller.applyInput("connection-a", {
          sequence: 1,
          clientTick: 0,
          angle: 0,
          boosting: false,
        }),
        "current client tick was rejected",
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
