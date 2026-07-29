import { Container, Sprite, type Texture } from "pixi.js";
import type { FoodConsumedEvent, FoodState } from "$lib/protocol";
import {
  FOOD_PREDICTION_CONTACT_GUARD,
  predictFoodCollisionPosition,
} from "$lib/game/star-food-motion";
import {
  eatContactDistance,
  foodRadiusOf,
  isStarFood,
  maximumFoodRadius,
  type FoodRadiusRules,
} from "$lib/game/food-metrics";
import {
  advanceFoodAbsorbTrackingState,
  createFoodAbsorbState,
  createFoodAbsorbTrackingState,
  sampleFoodAbsorbState,
  type FoodAbsorbSample,
  type FoodAbsorbState,
  type FoodAbsorbTrackingState,
} from "./food-absorb-effect";

interface ViewBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface AuthoritativeFoodAbsorb {
  readonly kind: "authoritative";
  readonly event: FoodConsumedEvent;
  state: FoodAbsorbState | undefined;
}

interface PredictedFoodAbsorb {
  readonly kind: "predicted";
  readonly playerId: string;
  state: FoodAbsorbTrackingState;
  readonly predictedAtSourceFrame: number;
  event: FoodConsumedEvent | undefined;
  complete: boolean;
}

type ActiveFoodAbsorb = AuthoritativeFoodAbsorb | PredictedFoodAbsorb;

interface FoodRecord {
  node: Sprite;
  food: FoodState;
  x: number;
  y: number;
  kind: FoodState["kind"];
  variant: number;
  star: boolean;
  absorb: ActiveFoodAbsorb | undefined;
  respawn: FoodState | undefined;
  consumed: FoodConsumedEvent | undefined;
  speculationBlocked: boolean;
}

export interface FoodTextures {
  readonly dots: ReadonlyArray<Texture>;
  readonly star: Texture;
  /** 残骸贴图组，加速掉落与死亡残骸共用。 */
  readonly candy: ReadonlyArray<Texture>;
}

/**
 * 食物层：彩点、星星与残骸贴图。
 *
 * 显示直径由权威半径推出，与服务端判定尺寸一致；彩点与残骸使用权威随机帧，
 * 保证同一份食物在吸附、重生和节点重建后保持同一张贴图。
 */
export class FoodLayer {
  readonly container = new Container();
  private readonly ambientContainer = new Container();
  private readonly remainsContainer = new Container();
  private readonly records = new Map<number, FoodRecord>();
  private authoritativeFoods = new Map<number, FoodState>();
  private authoritativeSourceFrame = 0;
  private readonly cullMargin: number;

  constructor(
    private readonly rules: FoodRadiusRules,
    private readonly textures: FoodTextures,
    private readonly arenaExtent = Number.POSITIVE_INFINITY,
  ) {
    if (textures.dots.length === 0) throw new Error("Food dot textures are missing");
    if (textures.candy.length === 0) throw new Error("Remains textures are missing");
    // 原版 BottomZIndex：普通食物为 Zero，残骸为 One，不能由创建顺序决定层级。
    this.container.addChild(this.ambientContainer, this.remainsContainer);
    this.cullMargin = maximumFoodRadius() * 2;
  }

  /** 供特效/音效查询食物最后已知位置。 */
  positionOf(foodId: number): { x: number; y: number; kind: FoodState["kind"] } | undefined {
    const record = this.records.get(foodId);
    return record && record.consumed === undefined
      ? { x: record.x, y: record.y, kind: record.kind }
      : undefined;
  }

  sync(
    foods: ReadonlyArray<FoodState>,
    view: ViewBounds,
    authoritativeSourceFrame: number,
    authoritativeFoods: ReadonlyArray<FoodState> = foods,
  ): void {
    this.authoritativeSourceFrame = authoritativeSourceFrame;
    this.authoritativeFoods = new Map(authoritativeFoods.map((food) => [food.id, food]));
    const seen = new Set<number>();
    for (const food of foods) {
      seen.add(food.id);
      const star = isStarFood(food, this.rules);
      let record = this.records.get(food.id);
      if (
        !record ||
        record.kind !== food.kind ||
        record.variant !== food.variant ||
        record.star !== star
      ) {
        record?.node.destroy();
        record = this.createRecord(food, star);
        this.records.set(food.id, record);
      }
      record.food = food;

      if (record.consumed !== undefined) {
        if (record.consumed.food.generation === food.generation) {
          record.node.visible = false;
          continue;
        }
        record.consumed = undefined;
        record.speculationBlocked = false;
      }

      const absorb = record.absorb;
      if (absorb?.kind === "predicted" && absorb.event === undefined) {
        if (authoritativeSourceFrame >= Math.ceil(absorb.predictedAtSourceFrame)) {
          record.absorb = undefined;
          record.respawn = undefined;
          record.consumed = undefined;
          record.speculationBlocked = true;
          record.x = food.position.x;
          record.y = food.position.y;
          record.node.position.set(record.x, record.y);
          this.updateVisibility(record, view);
        } else {
          this.updateVisibility(record, view);
        }
        continue;
      }

      // 权威事件开始后，插值缓冲仍可能采到碰撞前的同一份食物；它不是重生。
      if (absorb !== undefined) {
        const event = absorb.event;
        if (event !== undefined && !isRespawnGeneration(event.food, food)) {
          this.updateVisibility(record, view);
          continue;
        }
        record.respawn = food;
        this.updateVisibility(record, view);
        continue;
      }
      record.respawn = undefined;
      record.x = food.position.x;
      record.y = food.position.y;
      record.node.position.set(record.x, record.y);
      this.updateVisibility(record, view);
    }

    for (const [id, record] of this.records) {
      // 权威快照已删除食物，但原版会继续渲染到 0.2 秒动画结束。
      if (!seen.has(id) && record.absorb === undefined && record.consumed === undefined) {
        record.node.destroy();
        this.records.delete(id);
      }
    }
  }

  /** 登记权威碰撞；已有本机预测时只确认，不重置位置或动画帧。 */
  startAbsorb(event: FoodConsumedEvent): boolean {
    const { food } = event;
    const star = isStarFood(food, this.rules);
    let record = this.records.get(food.id);
    if (
      !record ||
      record.kind !== food.kind ||
      record.variant !== food.variant ||
      record.star !== star
    ) {
      record?.node.destroy();
      record = this.createRecord(food, star);
      this.records.set(food.id, record);
    }

    const active = record.absorb;
    if (
      record.consumed?.food.generation === food.generation &&
      record.consumed.sourceFrame === event.sourceFrame
    ) {
      return false;
    }
    record.consumed = undefined;
    if (active?.kind === "predicted") {
      if (active.event !== undefined) return false;
      if (active.playerId === event.playerId) {
        active.event = event;
        record.food = food;
        return true;
      }
      // 本机预测与权威消费者冲突：放弃预测，从权威碰撞帧重新呈现。
      record.absorb = undefined;
    } else if (active !== undefined) {
      return false;
    }

    record.food = food;
    record.x = food.position.x;
    record.y = food.position.y;
    record.node.position.set(record.x, record.y);
    record.node.visible = true;
    record.respawn = undefined;
    record.speculationBlocked = false;
    record.absorb = { kind: "authoritative", event, state: undefined };
    return true;
  }

  /**
   * 在本机预测蛇头首次进入原版进食圈时立即开始纯视觉吸附。
   * 长度、分数、删除与重生仍只由服务端权威状态决定。
   */
  predictSelfContacts(
    playerId: string,
    visibleHead: { readonly x: number; readonly y: number },
    collisionHead: { readonly x: number; readonly y: number },
    snakeRadius: number,
    eatDistanceFactor: number,
    presentationSourceFrame: number,
    collisionSourceFrame: number,
  ): Array<FoodState> {
    const predicted: Array<FoodState> = [];
    for (const record of this.records.values()) {
      if (record.absorb !== undefined || record.consumed !== undefined) continue;
      const authoritativeFood = this.authoritativeFoods.get(record.food.id);
      if (
        authoritativeFood === undefined ||
        authoritativeFood.generation !== record.food.generation
      ) {
        continue;
      }
      const radius = foodRadiusOf(authoritativeFood, this.rules);
      const contact = eatContactDistance(snakeRadius, radius, eatDistanceFactor);
      const visibleDx = visibleHead.x - record.x;
      const visibleDy = visibleHead.y - record.y;
      const visibleTouching = visibleDx * visibleDx + visibleDy * visibleDy < contact * contact;
      const collisionFoodPosition = predictFoodCollisionPosition(
        authoritativeFood,
        this.authoritativeSourceFrame,
        collisionSourceFrame,
        this.arenaExtent,
        radius,
      );
      const guardedContact = Math.max(0, contact - FOOD_PREDICTION_CONTACT_GUARD);
      const collisionDx =
        collisionFoodPosition === undefined
          ? Number.POSITIVE_INFINITY
          : collisionHead.x - collisionFoodPosition.x;
      const collisionDy =
        collisionFoodPosition === undefined
          ? Number.POSITIVE_INFINITY
          : collisionHead.y - collisionFoodPosition.y;
      const touching =
        visibleTouching &&
        collisionDx * collisionDx + collisionDy * collisionDy < guardedContact * guardedContact;
      if (record.speculationBlocked) {
        if (!visibleTouching) record.speculationBlocked = false;
        continue;
      }
      if (!touching) continue;

      record.absorb = {
        kind: "predicted",
        playerId,
        state: createFoodAbsorbTrackingState(
          { x: record.x, y: record.y },
          visibleHead,
          presentationSourceFrame,
        ),
        predictedAtSourceFrame: collisionSourceFrame,
        event: undefined,
        complete: false,
      };
      record.respawn = undefined;
      record.node.visible = true;
      predicted.push(authoritativeFood);
    }
    return predicted;
  }

  update(
    view: ViewBounds,
    presentationSourceFrame: (playerId: string) => number | undefined,
    presentationHead: (playerId: string) => { readonly x: number; readonly y: number } | undefined,
  ): Array<FoodConsumedEvent> {
    const presentedEvents: Array<FoodConsumedEvent> = [];
    for (const [id, record] of this.records) {
      const absorb = record.absorb;
      if (absorb === undefined) continue;
      const playerId = absorb.kind === "authoritative" ? absorb.event.playerId : absorb.playerId;
      const sourceFrame = presentationSourceFrame(playerId);
      if (sourceFrame === undefined) {
        this.updateVisibility(record, view);
        continue;
      }

      let sample: FoodAbsorbSample;
      if (absorb.kind === "authoritative") {
        if (sourceFrame < absorb.event.sourceFrame) {
          this.updateVisibility(record, view);
          continue;
        }
        if (absorb.state === undefined) {
          absorb.state = createFoodAbsorbState(
            absorb.event.food.position,
            absorb.event.target,
            sourceFrame,
          );
          presentedEvents.push(absorb.event);
        }
        sample = sampleFoodAbsorbState(absorb.state, sourceFrame);
      } else {
        const currentHead = presentationHead(playerId) ?? absorb.state.target;
        const tracking = advanceFoodAbsorbTrackingState(absorb.state, sourceFrame, currentHead);
        absorb.state = tracking.state;
        sample = tracking;
      }

      record.x = sample.position.x;
      record.y = sample.position.y;
      record.node.position.set(record.x, record.y);
      if (!sample.started) {
        this.updateVisibility(record, view);
        continue;
      }
      if (sample.complete) {
        if (absorb.kind === "predicted") {
          absorb.complete = true;
          if (absorb.event === undefined) {
            record.node.visible = false;
            continue;
          }
        }
        if (record.respawn !== undefined) {
          record.food = record.respawn;
          record.x = record.respawn.position.x;
          record.y = record.respawn.position.y;
          record.node.position.set(record.x, record.y);
          record.absorb = undefined;
          record.respawn = undefined;
          record.consumed = undefined;
          record.speculationBlocked = false;
          this.updateVisibility(record, view);
        } else {
          const event = absorb.event;
          if (event !== undefined && event.food.kind === "ambient") {
            record.absorb = undefined;
            record.respawn = undefined;
            record.consumed = event;
            record.speculationBlocked = false;
            record.node.visible = false;
          } else {
            record.node.destroy();
            this.records.delete(id);
          }
        }
        continue;
      }
      if (absorb.kind === "predicted") absorb.complete = false;
      this.updateVisibility(record, view);
    }
    return presentedEvents;
  }

  destroy(): void {
    for (const record of this.records.values()) record.node.destroy();
    this.records.clear();
  }

  private createRecord(food: FoodState, star: boolean): FoodRecord {
    const texture = this.textureFor(food, star);
    const node = new Sprite({ texture, anchor: 0.5 });
    const diameter = foodRadiusOf(food, this.rules) * 2;
    // 原版 GL 节点始终把 UV 铺满 `size × size` 方形 quad；部分 candy 帧并非正方形，
    // 因此必须分别缩放 X/Y，不能等比缩放后留下窄边。
    node.scale.set(diameter / Math.max(1, texture.width), diameter / Math.max(1, texture.height));
    const layer = food.kind === "ambient" ? this.ambientContainer : this.remainsContainer;
    layer.addChild(node);

    return {
      node,
      food,
      x: food.position.x,
      y: food.position.y,
      kind: food.kind,
      variant: food.variant,
      star,
      absorb: undefined,
      respawn: undefined,
      consumed: undefined,
      speculationBlocked: false,
    };
  }

  private updateVisibility(record: FoodRecord, view: ViewBounds): void {
    if (record.consumed !== undefined) {
      record.node.visible = false;
      return;
    }
    if (record.absorb?.kind === "predicted" && record.absorb.complete) {
      record.node.visible = false;
      return;
    }
    record.node.visible =
      record.x > view.left - this.cullMargin &&
      record.x < view.right + this.cullMargin &&
      record.y > view.top - this.cullMargin &&
      record.y < view.bottom + this.cullMargin;
  }

  private textureFor(food: FoodState, star: boolean): Texture {
    let frames: ReadonlyArray<Texture>;
    if (food.kind !== "ambient") frames = this.textures.candy;
    else if (star) frames = [this.textures.star];
    else frames = this.textures.dots;
    const texture = frames[food.variant % frames.length];
    if (!texture) throw new Error("Food texture lookup failed");
    return texture;
  }
}

function isRespawnGeneration(previous: FoodState, current: FoodState): boolean {
  return (
    previous.kind === "ambient" &&
    current.kind === "ambient" &&
    previous.generation !== current.generation
  );
}
