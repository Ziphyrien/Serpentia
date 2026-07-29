import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SKIN_ID } from "$lib/game/internal-skins";
import type { GameSnapshot } from "$lib/protocol";
import { defaultGameConfig, type GameConfig } from "$lib/server/game/config";
import { GameEngine } from "$lib/server/game/engine";
import { RoomController, type AppliedInputAck } from "$lib/server/room/room-controller";
import { SelfPredictor, type ScheduledInput } from "./self-predictor";

interface ScheduledDelivery<T> {
  readonly at: number;
  readonly payload: T;
}

type ServerDelivery =
  | { readonly _tag: "ack"; readonly ack: AppliedInputAck }
  | { readonly _tag: "snapshot"; readonly snapshot: GameSnapshot };

function gameConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return { ...defaultGameConfig, dotFoodTarget: 0, starFoodTarget: 0, ...overrides };
}

function renderedHead(predictor: SelfPredictor): { x: number; y: number } {
  const head = predictor.renderState()?.body[0];
  if (head === undefined) throw new Error("predicted snake has no head");
  return head;
}

describe("target-tick prediction over delayed transport", () => {
  it("uses the measured lead to absorb a late steering packet", () => {
    const config = gameConfig({ arenaHalfSize: 10_000, spawnClearance: 1_000 });
    const controller = new RoomController(new GameEngine(config, 7, false));
    const joined = controller.join("connection", {
      playerId: "self",
      nickname: "Self",
      skinId: DEFAULT_SKIN_ID,
    });
    if (joined._tag !== "Accepted") throw new Error("test connection was rejected");
    const predictor = new SelfPredictor(config, config.tickRate);
    predictor.reconcile(joined.snapshot.snakes[0], joined.snapshot.tick, 0);
    predictor.setPredictionLeadTicks(3);

    const targetTick = predictor.nextInputTick;
    controller.tick();
    controller.tick();
    controller.tick();
    const accepted = controller.applyInput("connection", {
      sequence: 1,
      targetTick,
      angle: Math.PI / 2,
      boosting: false,
    });

    if (accepted === false) throw new Error("late steering input was rejected");
    expect(accepted.targetTick).toBe(targetTick);
    expect(accepted.appliedTick).toBe(targetTick);
  });

  it("matches authority through continuous turns and an ordered latency spike", () => {
    const config = gameConfig({ arenaHalfSize: 10_000, spawnClearance: 1_000 });
    const controller = new RoomController(new GameEngine(config, 7, false));
    const joined = controller.join("connection", {
      playerId: "self",
      nickname: "Self",
      skinId: DEFAULT_SKIN_ID,
    });
    if (joined._tag !== "Accepted") throw new Error("test connection was rejected");
    const initialSnake = joined.snapshot.snakes[0];
    const predictor = new SelfPredictor(config, config.tickRate);
    predictor.reconcile(initialSnake, joined.snapshot.tick, 0);

    const clientToServer: Array<ScheduledDelivery<ScheduledInput>> = [];
    const serverToClient: Array<ScheduledDelivery<ServerDelivery>> = [];
    let clientToServerTail = 0;
    let serverToClientTail = 0;
    let sequence = 0;
    let intentAngle = initialSnake.angle;
    const snapshotCorrections = new Map<number, number>();

    const sendInput = (now: number, input: ScheduledInput, latency: number): void => {
      clientToServerTail = Math.max(now + latency, clientToServerTail + 1);
      clientToServer.push({ at: clientToServerTail, payload: input });
    };
    const sendServer = (now: number, payload: ServerDelivery): void => {
      serverToClientTail = Math.max(now + 25, serverToClientTail + 1);
      serverToClient.push({ at: serverToClientTail, payload });
    };

    for (let now = 0; now <= 1_600; now += 5) {
      if (now <= 1_000 && now % 50 === 0) {
        intentAngle = initialSnake.angle + now * 0.003;
        const input: ScheduledInput = {
          sequence: sequence++,
          targetTick: predictor.nextInputTick,
          angle: intentAngle,
          boosting: false,
        };
        predictor.scheduleInput(input);
        sendInput(now, input, now === 300 ? 230 : 25);
      }

      while (clientToServer[0]?.at <= now) {
        const delivery = clientToServer.shift();
        if (delivery === undefined) break;
        const accepted = controller.applyInput("connection", delivery.payload);
        expect(accepted).not.toBe(false);
      }

      if (now > 0 && now % 50 === 0) {
        const result = controller.tick();
        for (const ack of result.appliedInputs) sendServer(now, { _tag: "ack", ack });
        if (controller.currentTick % 2 === 0) {
          sendServer(now, { _tag: "snapshot", snapshot: controller.snapshot() });
        }
      }

      while (serverToClient[0]?.at <= now) {
        const delivery = serverToClient.shift();
        if (delivery === undefined) break;
        if (delivery.payload._tag === "ack") {
          const ack = delivery.payload.ack;
          predictor.acknowledgeInput(ack.sequence, ack.targetTick, ack.appliedTick);
          continue;
        }

        const snapshot = delivery.payload.snapshot;
        const self = snapshot.snakes.find((snake) => snake.id === "self");
        if (self === undefined) throw new Error("authoritative snake disappeared");
        const before = renderedHead(predictor);
        predictor.reconcile(self, snapshot.tick, now);
        const after = renderedHead(predictor);
        snapshotCorrections.set(snapshot.tick, Math.hypot(after.x - before.x, after.y - before.y));
      }

      predictor.advance(now);
    }

    expect(snapshotCorrections.get(2)).toBeLessThan(1e-8);
    expect(snapshotCorrections.get(4)).toBeLessThan(1e-8);
    expect(snapshotCorrections.get(6)).toBeLessThan(1e-8);
    expect(snapshotCorrections.get(8)).toBeLessThan(1e-8);
    expect(snapshotCorrections.get(10)).toBeGreaterThan(0.01);
    for (const [tick, correction] of snapshotCorrections) {
      if (tick >= 12) expect(correction).toBeLessThan(1e-8);
    }

    const authoritative = controller.snapshot().snakes[0].body[0];
    const predicted = predictor.headAtTick(controller.currentTick);
    expect(predicted).toBeDefined();
    expect(predicted!.x).toBeCloseTo(authoritative.x, 8);
    expect(predicted!.y).toBeCloseTo(authoritative.y, 8);
  });
});
