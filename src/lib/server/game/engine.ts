import {
  SNAKE_BODY,
  advanceSnakeSourceFrame,
  applySnakeBoostInput,
  createBody,
  quantizeSnakeTargetAngle,
  snakeBodyRadius,
  snakeCollisionDistance,
  targetSnakeBodyScale,
  willDrainBoostSourceFrame,
  type SnakeMotionRules,
} from "../../game/snake-motion";
import { hasCrossedBorder, MAP_BORDER } from "../../game/arena";
import { normalGameDegreesToRadians } from "../../game/normal-game-math";
import {
  DEFAULT_SKIN_ID,
  bodyPointIndexes,
  internalSkinOrDefault,
  isInternalSkinId,
  skinSizeInfo,
} from "../../game/internal-skins";
import {
  DEAD_REMAINS_BASE_VALUE,
  DEAD_REMAINS_LENGTH_VALUE,
  FOOD_ABSORB_SOURCE_FRAME_COUNT,
  FOOD_RESPAWN_SAFE_DISTANCE,
  FOOD_VARIANT_COUNT,
  STAR_FOOD_DIRECTION_FRAME_MAX_EXCLUSIVE,
  STAR_FOOD_DIRECTION_FRAME_MIN,
  STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME,
  eatContactDistance,
  foodRadiusOf,
  isStarFood,
  maximumFoodRadius,
} from "../../game/food-metrics";
import { BodySpatialIndex } from "./body-spatial-index";
import { defaultGameConfig, motionRulesFor, type GameConfig } from "./config";
import { distanceSquared, pointToSegmentDistanceSquared, type Point } from "./geometry";
import type {
  DeathCause,
  DeathEvent,
  FoodConsumedEvent,
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
  /** 权威皮肤 ID；缺省时使用官方默认皮肤。 */
  readonly skinId?: number;
}

interface PendingAmbientFoodRespawn {
  readonly food: FoodState;
  readonly respawnAtSourceFrame: number;
}

interface StarFoodMotion {
  directionDegrees: number;
  directionFrameCount: number;
  directionFrameTarget: number;
  boundaryX: number;
  boundaryY: number;
}

export class GameEngine {
  readonly config: GameConfig;
  private readonly motion: SnakeMotionRules;
  private readonly random: DeterministicRandom;
  private readonly snakes = new Map<string, SnakeState>();
  private readonly orderedSnakes: Array<SnakeState> = [];
  private readonly foods = new Map<number, FoodState>();
  private readonly starFoodMotion = new Map<number, StarFoodMotion>();
  private readonly pendingAmbientFoodRespawns: Array<PendingAmbientFoodRespawn> = [];
  private readonly foodIndex: FoodSpatialIndex;
  private nextFoodId = 1;
  private dotFoodCount = 0;
  private starFoodCount = 0;
  private currentTick = 0;
  private currentSourceFrame = 0;

  constructor(config: GameConfig = defaultGameConfig, seed = 1, populateAmbientFood = true) {
    this.config = config;
    this.motion = motionRulesFor(config);
    this.random = new DeterministicRandom(seed);
    this.foodIndex = new FoodSpatialIndex(
      eatContactDistance(
        snakeBodyRadius(SNAKE_BODY.maximumScale),
        maximumFoodRadius(),
        config.eatDistanceFactor,
      ) * 2,
    );
    if (populateAmbientFood) this.replenishAmbientFood();
  }

  get tick(): number {
    return this.currentTick;
  }

  addSnake(playerId: string, nickname: string, options: SnakeSpawnOptions = {}): boolean {
    if (this.snakes.has(playerId)) return false;

    const angle = quantizeSnakeTargetAngle(options.angle ?? this.random.angle());
    const length = Math.max(
      this.config.minimumLength,
      Math.round(options.length ?? this.config.initialLength),
    );
    const position = options.position ?? this.findSafeSpawn();
    const body = options.body
      ? options.body.map((point) => ({ x: point.x, y: point.y }))
      : createBody(position, angle, length, this.motion);

    const snake: SnakeState = {
      id: playerId,
      nickname,
      skinId: resolveSkinId(options.skinId),
      body,
      angle,
      targetAngle: angle,
      length,
      bodyScale: targetSnakeBodyScale(length, this.config.minimumLength),
      score: length,
      kills: 0,
      boosting: false,
      boostInputHeld: false,
      boostFrames: 0,
      alive: true,
      respawnAtTick: undefined,
      invulnerableUntilSourceFrame: this.invulnerabilityDeadline(options.invulnerabilityTicks ?? 0),
      lastInputSequence: -1,
      lastInputAppliedTick: 0,
    };
    this.snakes.set(playerId, snake);
    const insertionIndex = this.orderedSnakes.findIndex(
      (current) => current.id.localeCompare(playerId) > 0,
    );
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

  /** 重连后沿用同一条蛇，但采用会话当前选择的皮肤。 */
  reskinSnake(playerId: string, skinId: number | undefined): boolean {
    const snake = this.snakes.get(playerId);
    if (!snake) return false;
    snake.skinId = resolveSkinId(skinId);
    return true;
  }

  suspendSnake(playerId: string): boolean {
    const snake = this.snakes.get(playerId);
    if (snake === undefined) return false;
    snake.boosting = false;
    snake.boostInputHeld = false;
    snake.boostFrames = 0;
    return true;
  }

  addFood(
    position: Point,
    value: number,
    kind: FoodKind = "ambient",
    lengthValue: number = value,
  ): number {
    const id = this.nextFoodId;
    this.nextFoodId += 1;
    const isAmbientStar = kind === "ambient" && value >= this.config.starFoodValue;
    let variant: number;
    if (isAmbientStar) variant = 0;
    else if (kind === "ambient") variant = this.random.integer(0, FOOD_VARIANT_COUNT.dot);
    else variant = this.random.integer(0, FOOD_VARIANT_COUNT.candy);

    let motion: StarFoodMotion | undefined;
    if (isAmbientStar) {
      motion = {
        directionDegrees: this.random.integer(0, 360),
        directionFrameCount: 0,
        directionFrameTarget: this.random.integer(
          STAR_FOOD_DIRECTION_FRAME_MIN,
          STAR_FOOD_DIRECTION_FRAME_MAX_EXCLUSIVE,
        ),
        boundaryX: position.x,
        boundaryY: position.y,
      };
    }
    const food: FoodState = {
      id,
      position,
      value,
      lengthValue,
      variant,
      generation: 0,
      ...(motion === undefined ? {} : { motion: starFoodMotionState(motion) }),
      kind,
    };
    this.foods.set(id, food);
    this.foodIndex.add(food);
    this.countFood(food, 1);
    if (motion !== undefined) this.starFoodMotion.set(id, motion);
    return id;
  }

  applyInput(input: PlayerInput): boolean {
    const snake = this.snakes.get(input.playerId);
    if (!snake || !snake.alive || input.sequence <= snake.lastInputSequence) return false;
    if (!Number.isFinite(input.angle)) return false;

    snake.lastInputSequence = input.sequence;
    snake.lastInputAppliedTick = input.appliedTick ?? this.currentTick + 1;
    snake.targetAngle = quantizeSnakeTargetAngle(input.angle);
    applySnakeBoostInput(snake, input.boosting, this.config.minimumLength);
    return true;
  }

  handledInputAt(playerId: string, sequence: number, appliedTick: number): boolean {
    const snake = this.snakes.get(playerId);
    return (
      snake !== undefined &&
      snake.lastInputSequence >= sequence &&
      snake.lastInputAppliedTick === appliedTick
    );
  }

  step(inputs: ReadonlyArray<PlayerInput> = []): TickEvents {
    this.currentTick += 1;
    const respawnedPlayerIds = this.respawnReadySnakes();
    for (const input of inputs) {
      this.applyInput({ ...input, appliedTick: input.appliedTick ?? this.currentTick });
    }

    const deaths: Array<DeathEvent> = [];
    const consumedFoods: Array<FoodConsumedEvent> = [];
    for (let frame = 0; frame < this.motion.sourceFramesPerTick; frame += 1) {
      this.currentSourceFrame += 1;
      this.moveAliveSnakesOneSourceFrame();
      this.moveStarFoodsOneSourceFrame();
      this.respawnAmbientFoods();
      deaths.push(...this.resolveDeaths());
      consumedFoods.push(...this.consumeFood());
    }
    this.replenishAmbientFood();

    return { deaths, consumedFoods, respawnedPlayerIds };
  }

  snapshot(): GameSnapshot {
    const snakes = this.orderedSnakes.map((snake) => ({
      id: snake.id,
      nickname: snake.nickname,
      skinId: snake.skinId,
      body: snake.body.map((point) => ({ x: point.x, y: point.y })),
      angle: snake.angle,
      targetAngle: snake.targetAngle,
      bodyScale: snake.bodyScale,
      length: snake.length,
      score: snake.score,
      kills: snake.kills,
      boosting: snake.boosting,
      alive: snake.alive,
      invulnerable: this.isInvulnerable(snake),
      respawnAtTick: snake.respawnAtTick ?? null,
      lastInputSequence: snake.lastInputSequence,
      lastInputAppliedTick: snake.lastInputAppliedTick,
    }));

    const leaderboard = snakes
      .filter((snake) => snake.alive)
      .sort((left, right) => right.score - left.score)
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

  private invulnerabilityDeadline(ticks: number): number {
    return (
      this.currentSourceFrame + Math.max(0, Math.floor(ticks)) * this.motion.sourceFramesPerTick
    );
  }

  private isInvulnerable(snake: SnakeState): boolean {
    return snake.alive && this.currentSourceFrame < snake.invulnerableUntilSourceFrame;
  }

  private moveAliveSnakesOneSourceFrame(): void {
    for (const snake of this.orderedSnakes) {
      if (!snake.alive) continue;
      // 原版 processSpeedUp 先从旧身体的最后一个渲染节取掉落点，
      // 随后 updateSnakePoints 才缩短并移动身体。
      const boostDropPosition = this.pendingBoostDropPosition(snake);
      const drained = advanceSnakeSourceFrame(snake, this.motion);
      if (drained <= 0) continue;
      // 原版 addScore(-1) 也会经 setScore 逐次取整。
      snake.score = Math.round(snake.score - drained);
      if (boostDropPosition !== undefined) {
        this.addFood(boostDropPosition, this.config.boostRemainsValue * drained, "boost-remains");
      }
    }
  }

  private pendingBoostDropPosition(snake: SnakeState): Point | undefined {
    if (!willDrainBoostSourceFrame(snake, this.motion)) return undefined;
    const indexes = this.renderedBodyPointIndexes(snake);
    const tailIndex = indexes[indexes.length - 1];
    const tail = tailIndex === undefined ? undefined : snake.body[tailIndex];
    return tail === undefined ? undefined : { x: tail.x, y: tail.y };
  }

  private resolveDeaths(): Array<DeathEvent> {
    const pending = new Map<string, DeathCause>();
    const snakes = this.orderedSnakes.filter((snake) => snake.alive);
    const maximumCollisionDistance = snakeCollisionDistance(
      SNAKE_BODY.maximumScale,
      SNAKE_BODY.maximumScale,
    );
    const bodyIndex = new BodySpatialIndex(maximumCollisionDistance * 2);

    for (const other of snakes) {
      if (this.isInvulnerable(other)) continue;
      for (let index = 1; index < other.body.length; index += 1) {
        bodyIndex.add({
          snakeId: other.id,
          start: other.body[index - 1],
          end: other.body[index],
        });
      }
    }

    for (const snake of snakes) {
      const head = snake.body[0];
      if (hasCrossedBorder(head, snakeBodyRadius(snake.bodyScale), this.config.arenaHalfSize)) {
        pending.set(snake.id, { _tag: "Boundary" });
        continue;
      }

      if (this.isInvulnerable(snake)) continue;
      const queryDistance = snakeCollisionDistance(snake.bodyScale, SNAKE_BODY.maximumScale);
      for (const segmentOrder of bodyIndex.query(head, queryDistance)) {
        const segment = bodyIndex.get(segmentOrder);
        if (segment === undefined || segment.snakeId === snake.id) continue;
        const other = this.snakes.get(segment.snakeId);
        if (other === undefined) continue;
        const collisionDistance = snakeCollisionDistance(snake.bodyScale, other.bodyScale);
        if (
          pointToSegmentDistanceSquared(head, segment.start, segment.end) <
          collisionDistance * collisionDistance
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
      snake.boostInputHeld = false;
      snake.boostFrames = 0;
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

  private consumeFood(): Array<FoodConsumedEvent> {
    const consumed = new Map<number, FoodConsumedEvent>();
    for (const snake of this.orderedSnakes) {
      if (!snake.alive) continue;
      const head = snake.body[0];
      const bodyRadius = snakeBodyRadius(snake.bodyScale);
      const reach = eatContactDistance(
        bodyRadius,
        maximumFoodRadius(),
        this.config.eatDistanceFactor,
      );
      for (const foodId of this.foodIndex.query(head, reach)) {
        if (consumed.has(foodId)) continue;
        const food = this.foods.get(foodId);
        if (food === undefined) continue;
        const contact = eatContactDistance(
          bodyRadius,
          foodRadiusOf(food, this.config),
          this.config.eatDistanceFactor,
        );
        if (distanceSquared(head, food.position) >= contact * contact) continue;
        consumed.set(food.id, {
          playerId: snake.id,
          sourceFrame: this.currentSourceFrame,
          food: {
            ...food,
            position: { x: food.position.x, y: food.position.y },
          },
          target: { x: head.x, y: head.y },
        });
        // 正常新无尽的 actAsEndless() 会忽略 food.lengthValue，
        // 以最终分值同时增加长度和分数，并在每次进食后分别取整。
        snake.length = Math.round(snake.length + food.value);
        snake.score = Math.round(snake.score + food.value);
      }
    }

    for (const { food } of consumed.values()) {
      this.foodIndex.remove(food);
      this.foods.delete(food.id);
      if (food.kind === "ambient") {
        this.pendingAmbientFoodRespawns.push({
          food,
          respawnAtSourceFrame: this.currentSourceFrame + FOOD_ABSORB_SOURCE_FRAME_COUNT,
        });
      } else {
        this.countFood(food, -1);
      }
    }
    return [...consumed.values()];
  }

  private renderedBodyPointIndexes(snake: SnakeState): Array<number> {
    const skin = internalSkinOrDefault(snake.skinId);
    return bodyPointIndexes(skinSizeInfo(skin, snake.bodyScale), snake.body.length);
  }

  /** 每个官方渲染身体节掉落一份残骸；总分由分数按幂函数换算。 */
  private dropRemains(snake: SnakeState): void {
    const indexes = this.renderedBodyPointIndexes(snake);
    const pieces = indexes.length;
    if (pieces <= 0) return;
    const totalScore =
      Math.pow(snake.score, this.config.remainsScoreExponent) * this.config.remainsScoreFactor;
    const value = Math.max(totalScore / pieces, DEAD_REMAINS_BASE_VALUE);
    for (const pointIndex of indexes) {
      const point = snake.body[pointIndex];
      if (point === undefined) continue;
      this.addFood(
        {
          x: this.clampToArena(point.x + this.random.integer(2, 40)),
          y: this.clampToArena(point.y + this.random.integer(2, 40)),
        },
        value,
        "remains",
        DEAD_REMAINS_LENGTH_VALUE,
      );
    }
  }

  private respawnReadySnakes(): Array<string> {
    const respawned: Array<string> = [];
    for (const snake of this.orderedSnakes) {
      if (snake.alive || snake.respawnAtTick === undefined) continue;
      if (snake.respawnAtTick > this.currentTick) continue;

      const position = this.findSafeSpawn();
      const angle = this.random.angle();
      snake.body = createBody(position, angle, this.config.initialLength, this.motion);
      snake.angle = angle;
      snake.targetAngle = angle;
      snake.length = this.config.initialLength;
      snake.bodyScale = targetSnakeBodyScale(this.config.initialLength, this.config.minimumLength);
      snake.score = this.config.initialLength;
      snake.boosting = false;
      snake.boostInputHeld = false;
      snake.boostFrames = 0;
      snake.alive = true;
      snake.respawnAtTick = undefined;
      snake.invulnerableUntilSourceFrame = this.invulnerabilityDeadline(
        this.config.respawnInvulnerabilityTicks,
      );
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

  private moveStarFoodsOneSourceFrame(): void {
    const extent = this.config.arenaHalfSize - MAP_BORDER;
    for (const food of this.foods.values()) {
      const motion = this.starFoodMotion.get(food.id);
      if (motion === undefined) continue;

      motion.directionFrameCount += 1;
      if (motion.directionFrameCount >= motion.directionFrameTarget) {
        this.resetStarFoodDirection(motion, this.random.integer(0, 360));
      }

      const radius = foodRadiusOf(food, this.config);
      if (motion.boundaryX - radius < -extent) {
        this.resetStarFoodDirection(motion, 0);
      } else if (motion.boundaryY + radius > extent) {
        this.resetStarFoodDirection(motion, 270);
      } else if (motion.boundaryX + radius > extent) {
        this.resetStarFoodDirection(motion, 180);
      } else if (motion.boundaryY - radius < -extent) {
        this.resetStarFoodDirection(motion, 90);
      }

      const radians = normalGameDegreesToRadians(motion.directionDegrees);
      const moved: FoodState = {
        ...food,
        position: {
          x: food.position.x + STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME * Math.cos(radians),
          y: food.position.y + STAR_FOOD_MOVE_DISTANCE_PER_SOURCE_FRAME * Math.sin(radians),
        },
        motion: starFoodMotionState(motion),
      };
      motion.boundaryX = food.position.x;
      motion.boundaryY = food.position.y;
      this.foodIndex.remove(food);
      this.foods.set(food.id, moved);
      this.foodIndex.add(moved);
    }
  }

  private resetStarFoodDirection(motion: StarFoodMotion, directionDegrees: number): void {
    motion.directionDegrees = directionDegrees;
    motion.directionFrameCount = 0;
    motion.directionFrameTarget = this.random.integer(
      STAR_FOOD_DIRECTION_FRAME_MIN,
      STAR_FOOD_DIRECTION_FRAME_MAX_EXCLUSIVE,
    );
  }

  private respawnAmbientFoods(): void {
    const extent = this.config.arenaHalfSize - MAP_BORDER;
    let writeIndex = 0;
    for (const pending of this.pendingAmbientFoodRespawns) {
      if (pending.respawnAtSourceFrame > this.currentSourceFrame) {
        this.pendingAmbientFoodRespawns[writeIndex] = pending;
        writeIndex += 1;
        continue;
      }

      let food: FoodState = {
        ...pending.food,
        generation: pending.food.generation === 0 ? 1 : 0,
        position: {
          x: this.randomSafeFoodCoordinate(pending.food.position.x, -extent, extent),
          y: this.randomSafeFoodCoordinate(pending.food.position.y, -extent, extent),
        },
      };
      const motion = this.starFoodMotion.get(food.id);
      if (motion !== undefined) {
        motion.boundaryX = food.position.x;
        motion.boundaryY = food.position.y;
        food = { ...food, motion: starFoodMotionState(motion) };
      }
      this.foods.set(food.id, food);
      this.foodIndex.add(food);
    }
    this.pendingAmbientFoodRespawns.length = writeIndex;
  }

  /** 对齐旧无尽 `MapUtil.randomSafeXY`：每条轴独立选择旧位置 100 以外的一侧。 */
  private randomSafeFoodCoordinate(value: number, minimum: number, maximum: number): number {
    const lower = value - FOOD_RESPAWN_SAFE_DISTANCE;
    const upper = value + FOOD_RESPAWN_SAFE_DISTANCE;
    if (lower <= minimum) return this.random.integer(upper, maximum);
    if (upper >= maximum || this.random.next() < 0.5) {
      return this.random.integer(minimum, lower);
    }
    return this.random.integer(upper, maximum);
  }

  private replenishAmbientFood(): void {
    const extent = this.config.arenaHalfSize - MAP_BORDER;
    while (this.dotFoodCount < this.config.dotFoodTarget) {
      this.addFood(
        { x: this.random.integer(-extent, extent), y: this.random.integer(-extent, extent) },
        this.config.dotFoodValue,
      );
    }
    while (this.starFoodCount < this.config.starFoodTarget) {
      this.addFood(
        { x: this.random.integer(-extent, extent), y: this.random.integer(-extent, extent) },
        this.config.starFoodValue,
      );
    }
  }

  /** 环境食物按取值区分彩点与星星；残骸不参与补充计数。 */
  private countFood(food: FoodState, delta: number): void {
    if (food.kind !== "ambient") return;
    if (isStarFood(food, this.config)) this.starFoodCount += delta;
    else this.dotFoodCount += delta;
  }

  private clampToArena(value: number): number {
    const limit = this.config.arenaHalfSize - MAP_BORDER;
    return Math.min(limit, Math.max(-limit, value));
  }
}

function starFoodMotionState(motion: StarFoodMotion): NonNullable<FoodState["motion"]> {
  return {
    directionDegrees: motion.directionDegrees,
    linearFramesRemaining: motion.directionFrameTarget - motion.directionFrameCount,
  };
}

/** 皮肤 ID 必须存在于官方清单，否则回落到默认皮肤。 */
function resolveSkinId(skinId: number | undefined): number {
  return isInternalSkinId(skinId) ? skinId : DEFAULT_SKIN_ID;
}
