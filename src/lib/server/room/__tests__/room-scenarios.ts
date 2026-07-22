import { GameEngine } from "../../game/engine";
import { gameConfig } from "../../game/__tests__/game-config";
import { readPlayerIdentity } from "../connection-identity";
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
      controller.join("old", { playerId: "friend-a", nickname: "Alpha" });
      const result = controller.join("new", { playerId: "friend-a", nickname: "Alpha 2" });
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
      controller.join("connection-a", { playerId: "friend-a", nickname: "Alpha" });
      requireCondition(
        controller.applyInput("connection-a", {
          sequence: 1,
          angle: Math.PI / 2,
          boosting: true,
        }),
        "authorized input was rejected",
      );
      requireCondition(
        !controller.applyInput("unknown", { sequence: 2, angle: 0, boosting: true }),
        "unknown connection injected input",
      );
      controller.tick();
      const snapshot = controller.snapshot();
      const snake = snapshot.snakes[0];
      requireCondition(snapshot.snakes.length === 1, "unexpected snake count");
      requireCondition(snake.id === "friend-a", "connection spoofed player identity");
      requireCondition(snake.boosting, "authorized boost input was not applied");
    },
  },
  {
    name: "PartyServer ingress accepts a bounded trusted player identity",
    run: () => {
      const identity = readPlayerIdentity(
        new Request("https://snake.example/api/parties/game-room/friends", {
          headers: {
            "x-serpentia-player-id": "friend-a",
            "x-serpentia-nickname": "  Alpha  ",
          },
        }),
      );
      requireCondition(identity !== undefined, "valid identity was rejected");
      requireCondition(identity.playerId === "friend-a", "player id changed");
      requireCondition(identity.nickname === "Alpha", "nickname was not normalized");
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
];
