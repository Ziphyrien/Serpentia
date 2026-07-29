import { describe, it } from "vite-plus/test";
import { Effect } from "effect";
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeServerMessage,
  GAME_PROTOCOL_VERSION,
} from "$lib/protocol/game";
import { GameEngine } from "$lib/server/game/engine";
import { gameConfig } from "../../../fixtures/server/game-config";
import { requireCondition } from "../../../support/assertions";

describe("authoritative game engine: protocol", () => {
  it("wire input messages are decoded through Effect Schema", () => {
    const message = Effect.runSync(
      decodeClientMessage(
        JSON.stringify({
          v: GAME_PROTOCOL_VERSION,
          _tag: "input",
          sequence: 4,
          targetTick: 3,
          angle: 1.2,
          boosting: true,
        }),
      ),
    );
    requireCondition(message._tag === "input", "input tag was not decoded");
    requireCondition(message.sequence === 4 && message.boosting, "input payload was changed");
  });
  it("input acknowledgements preserve requested and applied ticks", () => {
    const decoded = Effect.runSync(
      decodeServerMessage(
        encodeServerMessage({
          v: GAME_PROTOCOL_VERSION,
          _tag: "input-ack",
          sequence: 4,
          targetTick: 12,
          appliedTick: 13,
        }),
      ),
    );
    requireCondition(decoded._tag === "input-ack", "input ack tag was not decoded");
    requireCondition(
      decoded.targetTick === 12 && decoded.appliedTick === 13,
      "input ack collapsed its tick timeline",
    );
  });
  it("protocol v1 input is rejected after the target-tick upgrade", () => {
    let rejected = false;
    try {
      Effect.runSync(
        decodeClientMessage(
          JSON.stringify({
            v: 1,
            _tag: "input",
            sequence: 4,
            targetTick: 3,
            angle: 1.2,
            boosting: true,
          }),
        ),
      );
    } catch {
      rejected = true;
    }
    requireCondition(rejected, "obsolete protocol input was accepted");
  });
  it("malformed wire messages are rejected before simulation", () => {
    let rejected = false;
    try {
      Effect.runSync(
        decodeClientMessage(
          JSON.stringify({
            v: GAME_PROTOCOL_VERSION,
            _tag: "input",
            sequence: -1,
            targetTick: 1,
            angle: 0,
            boosting: false,
          }),
        ),
      );
    } catch {
      rejected = true;
    }
    requireCondition(rejected, "invalid input was accepted");
  });
  it("keeps leaderboard order aligned with authoritative new-endless score growth", () => {
    const engine = new GameEngine(gameConfig(), 1, false);
    engine.addSnake("longer", "Longer", {
      position: { x: 0, y: 0 },
      angle: 0,
      length: 100,
      invulnerabilityTicks: 100,
    });
    engine.addSnake("higher-score", "Higher score", {
      position: { x: 0, y: 500 },
      angle: 0,
      length: 80,
      invulnerabilityTicks: 100,
    });
    engine.addFood({ x: 0, y: 500 }, 30, "remains", 1);
    engine.step();

    const snapshot = engine.snapshot();
    const higherScore = snapshot.snakes.find((snake) => snake.id === "higher-score");
    const longer = snapshot.snakes.find((snake) => snake.id === "longer");
    requireCondition(
      higherScore !== undefined && longer !== undefined,
      "ranking fixture snakes were missing",
    );
    requireCondition(
      higherScore.length === higherScore.score,
      "new-endless food split logical length from score",
    );
    requireCondition(higherScore.length > longer.length, "ranking fixture did not grow longer");
    requireCondition(higherScore.score > longer.score, "ranking fixture did not gain more score");
    requireCondition(
      snapshot.leaderboard[0]?.playerId === "higher-score",
      "leaderboard ranked logical length instead of score",
    );
  });
  it("authoritative snapshots decode through the shared frontend contract", () => {
    const engine = new GameEngine(gameConfig(), 1, false);
    engine.addSnake("friend-a", "Alpha", { position: { x: 0, y: 0 }, angle: 0 });
    const encoded = encodeServerMessage({
      v: GAME_PROTOCOL_VERSION,
      _tag: "snapshot",
      serverTime: 1,
      snapshot: engine.snapshot(),
      events: [],
    });
    const decoded = Effect.runSync(decodeServerMessage(encoded));
    requireCondition(decoded._tag === "snapshot", "snapshot changed message type");
    requireCondition(decoded.snapshot.snakes.length === 1, "snapshot lost the snake");
    requireCondition(
      decoded.snapshot.snakes[0].respawnAtTick === null,
      "wire snapshot omitted its nullable respawn field",
    );
    requireCondition(
      decoded.snapshot.snakes[0].targetAngle === 0,
      "wire snapshot omitted its steering target",
    );
  });
});
