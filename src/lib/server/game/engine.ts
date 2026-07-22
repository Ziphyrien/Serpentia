import { BodySpatialIndex } from "./body-spatial-index";
import { defaultGameConfig, snakeRadius, type GameConfig } from "./config";
import {
  distance,
  distanceSquared,
  interpolate,
  move,
  pointToSegmentDistanceSquared,
  turnTowards,
  type Point,
} from "./geometry";
import type {
  DeathCause,
  DeathEvent,
  FoodKind,
  FoodState,
  GameSnapshot,
  PlayerInput,
  SnakeState,
  TickEvents,
} from "./model";
import { FoodSpatialIndex } from "./food-spatial-index";
import { DeterministicRandom } from "./random";

export interface SnakeSpawnOptions {
  readonly position?: Point;
  readonly angle?: number;
  readonly length?: number;
  readonly body?: ReadonlyArray<Point>;
  readonly invulnerabilityTicks?: number;
}

export class GameEngine {
  readonly config: GameConfig;
  private readonly random: DeterministicRandom;
  private readonly snakes = new Map<string, SnakeState>();
  private readonly orderedSnakes: Array<SnakeState> = [];
  private readonly foods = new Map<number, FoodState>();
  private readonly foodIndex: FoodSpatialIndex;
  private nextFoodId = 1;
  private ambientFoodCount = 0;
  private currentTick = 0;

  constructor(config: GameConfig = defaultGameConfig, seed = 1, populateAmbientFood = true) {
    this.config = config;
    this.random = new DeterministicRandom(seed);
    this.foodIndex = new FoodSpatialIndex((config.maximumRadius + config.foodRadius) * 2);
    if (populateAmbientFood) this.replenishAmbientFood();
  }

  get tick(): number {
    return this.currentTick;
  }

  addSnake(playerId: string, nickname: string, options: SnakeSpawnOptions = {}): boolean {
    if (this.snakes.has(playerId)) return false;

    const angle = options.angle ?? this.random.angle();
    const length = Math.max(this.config.minimumLength, options.length ?? this.config.initialLength);
    const position = options.position ?? this.findSafeSpawn();
    const body = options.body
      ? options.body.map((point) => ({ x: point.x, y: point.y }))
      : this.createInitialBody(position, angle, length);

    const snake: SnakeState = {
      id: playerId,
      nickname,
      body,
      angle,
      targetAngle: angle,
      length,
      score: 0,
      kills: 0,
      boosting: false,
      boostShed: 0,
      alive: true,
      respawnAtTick: undefined,
      invulnerableUntilTick: this.currentTick + (options.invulnerabilityTicks ?? 0),
      lastInputSequence: -1,
    };
    this.snakes.set(playerId, snake);
    const insertionIndex = this.orderedSnakes.findIndex((current) => current.id.localeCompare(playerId) > 0);
    if (insertionIndex === -1) this.orderedSnakes.push(snake);
    else this.orderedSnakes.splice(insertionIndex, 0, snake);
    return true;
  }

  removeSnake(playerId: string): boolean {
    const removed = this.snakes.delete(playerId);
    if (!removed) return false;
    const index = this.orderedSnakes.findIndex((snake) => snake.id === playerId);
    if (index !== -1) this.orderedSnakes.splice(index, 1);
    return true;
  }

  renameSnake(playerId: string, nickname: string): boolean {
    const snake = this.snakes.get(playerId);
    if (!snake) return false;
    snake.nickname = nickname;
    return true;
  }

  addFood(position: Point, value: number, kind: FoodKind = "ambient"): number {
    const id = this.nextFoodId;
    this.nextFoodId += 1;
    const food: FoodState = { id, position, value, kind };
    this.foods.set(id, food);
    this.foodIndex.add(food);
    if (kind === "ambient") this.ambientFoodCount += 1;
    return id;
  }

  clearFoods(): void {
    this.foods.clear();
    this.foodIndex.clear();
    this.ambientFoodCount = 0;
  }

  applyInput(input: PlayerInput): boolean {
    const snake = this.snakes.get(input.playerId);
    if (!snake || !snake.alive || input.sequence <= snake.lastInputSequence) return false;
    if (!Number.isFinite(input.angle)) return false;

    snake.lastInputSequence = input.sequence;
    snake.targetAngle = input.angle;
    snake.boosting = input.boosting;
    return true;
  }

  step(inputs: ReadonlyArray<PlayerInput> = []): TickEvents {
    this.currentTick += 1;
    const respawnedPlayerIds = this.respawnReadySnakes();
    for (const input of inputs) this.applyInput(input);

    this.moveAliveSnakes();
    const deaths = this.resolveDeaths();
    const consumedFoodIds = this.consumeFood();
    this.replenishAmbientFood();

    return { deaths, consumedFoodIds, respawnedPlayerIds };
  }

  snapshot(): GameSnapshot {
    const snakes = [...this.snakes.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((snake) => ({
        id: snake.id,
        nickname: snake.nickname,
        body: snake.body.map((point) => ({ x: point.x, y: point.y })),
        angle: snake.angle,
        length: snake.length,
        score: snake.score,
        kills: snake.kills,
        boosting: snake.boosting,
        alive: snake.alive,
        invulnerable: snake.alive && snake.invulnerableUntilTick >= this.currentTick,
        respawnAtTick: snake.respawnAtTick,
      }));

    const leaderboard = snakes
      .filter((snake) => snake.alive)
      .sort((left, right) => right.length - left.length || right.kills - left.kills)
      .map((snake) => ({
        playerId: snake.id,
        nickname: snake.nickname,
        length: snake.length,
        kills: snake.kills,
      }));

    return {
      tick: this.currentTick,
      snakes,
      foods: [...this.foods.values()].sort((left, right) => left.id - right.id),
      leaderboard,
    };
  }

  private moveAliveSnakes(): void {
    const secondsPerTick = 1 / this.config.tickRate;
    const maximumTurn = this.config.turnRate * secondsPerTick;

    for (const snake of this.sortedSnakes()) {
      if (!snake.alive) continue;

      const canBoost = snake.boosting && snake.length > this.config.boostMinimumLength;
      snake.angle = turnTowards(snake.angle, snake.targetAngle, maximumTurn);
      const speed = canBoost ? this.config.boostSpeed : this.config.baseSpeed;
      const head = move(snake.body[0], snake.angle, speed * secondsPerTick);
      snake.body.unshift(head);

      if (canBoost) this.drainBoost(snake, secondsPerTick);
      this.trimBody(snake);
    }
  }

  private drainBoost(snake: SnakeState, secondsPerTick: number): void {
    const drained = Math.min(
      this.config.boostDrainPerSecond * secondsPerTick,
      snake.length - this.config.minimumLength,
    );
    snake.length -= drained;
    snake.boostShed += drained;

    while (snake.boostShed >= this.config.boostDropValue) {
      const tail = snake.body[snake.body.length - 1];
      const scatterAngle = this.random.angle();
      const position = move(tail, scatterAngle, this.random.between(0, this.config.foodRadius * 2));
      this.addFood(position, this.config.boostDropValue, "boost");
      snake.boostShed -= this.config.boostDropValue;
    }
  }

  private trimBody(snake: SnakeState): void {
    let accumulated = 0;
    for (let index = 1; index < snake.body.length; index += 1) {
      const previous = snake.body[index - 1];
      const current = snake.body[index];
      const segmentLength = distance(previous, current);
      if (accumulated + segmentLength < snake.length) {
        accumulated += segmentLength;
        continue;
      }

      const remaining = Math.max(0, snake.length - accumulated);
      const ratio = segmentLength === 0 ? 0 : remaining / segmentLength;
      snake.body[index] = interpolate(previous, current, ratio);
      snake.body.splice(index + 1);
      return;
    }
  }

  private resolveDeaths(): Array<DeathEvent> {
    const pending = new Map<string, DeathCause>();
    const snakes = this.sortedSnakes().filter((snake) => snake.alive);
    const bodyIndex = new BodySpatialIndex(this.config.maximumRadius * 2);

    for (const other of snakes) {
      if (other.invulnerableUntilTick >= this.currentTick) continue;
      for (let index = 1; index < other.body.length; index += 1) {
        bodyIndex.add({
          snakeId: other.id,
          segmentIndex: index,
          start: other.body[index - 1],
          end: other.body[index],
        });
      }
    }

    for (const snake of snakes) {
      const head = snake.body[0];
      const radius = snakeRadius(snake.length, this.config);
      if (
        Math.abs(head.x) + radius >= this.config.arenaHalfSize ||
        Math.abs(head.y) + radius >= this.config.arenaHalfSize
      ) {
        pending.set(snake.id, { _tag: "Boundary" });
        continue;
      }

      if (snake.invulnerableUntilTick >= this.currentTick) continue;
      for (const segmentOrder of bodyIndex.query(head, radius + this.config.maximumRadius)) {
        const segment = bodyIndex.get(segmentOrder);
        if (segment === undefined || segment.snakeId === snake.id) continue;
        const other = this.snakes.get(segment.snakeId);
        if (other === undefined) continue;
        const collisionRadius = radius + snakeRadius(other.length, this.config);
        if (
          pointToSegmentDistanceSquared(head, segment.start, segment.end) <=
          collisionRadius * collisionRadius
        ) {
          pending.set(snake.id, { _tag: "Snake", killerId: segment.snakeId });
          break;
        }
      }
    }

    const events: Array<DeathEvent> = [];
    for (const [playerId, cause] of pending) {
      const snake = this.snakes.get(playerId);
      if (!snake || !snake.alive) continue;
      snake.alive = false;
      snake.boosting = false;
      snake.respawnAtTick = this.currentTick + this.config.respawnDelayTicks;
      this.dropRemains(snake);
      if (cause._tag === "Snake") {
        const killer = this.snakes.get(cause.killerId);
        if (killer) killer.kills += 1;
      }
      events.push({ playerId, cause });
    }
    return events;
  }

  private consumeFood(): Array<number> {
    const consumed = new Set<number>();
    for (const snake of this.sortedSnakes()) {
      if (!snake.alive) continue;
      const head = snake.body[0];
      const reach = snakeRadius(snake.length, this.config) + this.config.foodRadius;
      const reachSquared = reach * reach;
      for (const foodId of this.foodIndex.query(head, reach)) {
        if (consumed.has(foodId)) continue;
        const food = this.foods.get(foodId);
        if (food === undefined || distanceSquared(head, food.position) > reachSquared) continue;
        consumed.add(food.id);
        snake.length += food.value;
        snake.score += food.value;
      }
    }

    for (const id of consumed) {
      const food = this.foods.get(id);
      if (food !== undefined) {
        this.foodIndex.remove(food);
        if (food.kind === "ambient") this.ambientFoodCount -= 1;
      }
      this.foods.delete(id);
    }
    return [...consumed];
  }

  private dropRemains(snake: SnakeState): void {
    const positions = this.sampleBody(snake.body, this.config.deathFoodSpacing);
    if (positions.length === 0) return;
    const totalValue = Math.max(this.config.ambientFoodValue, snake.length * this.config.deathDropRatio);
    const value = totalValue / positions.length;
    for (const position of positions) this.addFood(position, value, "remains");
  }

  private sampleBody(body: ReadonlyArray<Point>, spacing: number): Array<Point> {
    if (body.length === 0) return [];
    const sampled: Array<Point> = [{ x: body[0].x, y: body[0].y }];
    let untilNext = spacing;

    for (let index = 1; index < body.length; index += 1) {
      let start = body[index - 1];
      const end = body[index];
      let segmentLength = distance(start, end);
      while (segmentLength >= untilNext && segmentLength > 0) {
        const point = interpolate(start, end, untilNext / segmentLength);
        sampled.push(point);
        start = point;
        segmentLength = distance(start, end);
        untilNext = spacing;
      }
      untilNext -= segmentLength;
    }
    return sampled;
  }

  private respawnReadySnakes(): Array<string> {
    const respawned: Array<string> = [];
    for (const snake of this.sortedSnakes()) {
      if (snake.alive || snake.respawnAtTick === undefined) continue;
      if (snake.respawnAtTick > this.currentTick) continue;

      const position = this.findSafeSpawn();
      const angle = this.random.angle();
      snake.body = this.createInitialBody(position, angle, this.config.initialLength);
      snake.angle = angle;
      snake.targetAngle = angle;
      snake.length = this.config.initialLength;
      snake.score = 0;
      snake.boosting = false;
      snake.boostShed = 0;
      snake.alive = true;
      snake.respawnAtTick = undefined;
      snake.invulnerableUntilTick = this.currentTick + this.config.respawnInvulnerabilityTicks;
      snake.lastInputSequence = -1;
      respawned.push(snake.id);
    }
    return respawned;
  }

  private findSafeSpawn(): Point {
    const margin = this.config.spawnClearance;
    const extent = this.config.arenaHalfSize - margin;
    let candidate = { x: 0, y: 0 };

    for (let attempt = 0; attempt < this.config.spawnAttempts; attempt += 1) {
      candidate = {
        x: this.random.between(-extent, extent),
        y: this.random.between(-extent, extent),
      };
      let safe = true;
      for (const snake of this.snakes.values()) {
        if (!snake.alive) continue;
        for (const point of snake.body) {
          if (distanceSquared(candidate, point) < margin * margin) {
            safe = false;
            break;
          }
        }
        if (!safe) break;
      }
      if (safe) return candidate;
    }
    return candidate;
  }

  private createInitialBody(position: Point, angle: number, length: number): Array<Point> {
    const pointCount = Math.ceil(length / this.config.bodyPointSpacing) + 1;
    const body: Array<Point> = [];
    for (let index = 0; index < pointCount; index += 1) {
      body.push(move(position, angle + Math.PI, index * this.config.bodyPointSpacing));
    }
    return trimPoints(body, length);
  }

  private replenishAmbientFood(): void {
    let ambientCount = this.ambientFoodCount;
    const extent = this.config.arenaHalfSize - this.config.foodRadius * 2;
    while (ambientCount < this.config.ambientFoodTarget) {
      this.addFood(
        {
          x: this.random.between(-extent, extent),
          y: this.random.between(-extent, extent),
        },
        this.config.ambientFoodValue,
      );
      ambientCount += 1;
    }
  }

  private sortedSnakes(): Array<SnakeState> {
    return this.orderedSnakes;
  }
}

function trimPoints(body: Array<Point>, length: number): Array<Point> {
  let accumulated = 0;
  for (let index = 1; index < body.length; index += 1) {
    const previous = body[index - 1];
    const current = body[index];
    const segmentLength = distance(previous, current);
    if (accumulated + segmentLength < length) {
      accumulated += segmentLength;
      continue;
    }

    const remaining = Math.max(0, length - accumulated);
    const ratio = segmentLength === 0 ? 0 : remaining / segmentLength;
    body[index] = interpolate(previous, current, ratio);
    body.splice(index + 1);
    return body;
  }
  return body;
}
