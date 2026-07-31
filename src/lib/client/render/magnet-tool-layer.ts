import { Container, Sprite, type Texture } from "pixi.js";
import type { MagnetConsumedEvent, MagnetToolState } from "$lib/protocol";
import {
  MAGNET,
  MAGNET_PICKUP_SOURCE_FRAME_COUNT,
  MAGNET_PREDICTION_CONTACT_GUARD,
  predictMagnetCollisionPosition,
} from "$lib/game/magnet";
import {
  advanceCollectibleAbsorbTrackingState,
  createCollectibleAbsorbState,
  createCollectibleAbsorbTrackingState,
  sampleCollectibleAbsorbState,
  type CollectibleAbsorbSample,
  type CollectibleAbsorbState,
  type CollectibleAbsorbTrackingState,
} from "./collectible-absorb-effect";

interface ViewBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface AuthoritativeMagnetAbsorb {
  readonly kind: "authoritative";
  readonly event: MagnetConsumedEvent;
  state: CollectibleAbsorbState | undefined;
}

interface PredictedMagnetAbsorb {
  readonly kind: "predicted";
  readonly playerId: string;
  state: CollectibleAbsorbTrackingState;
  readonly predictedAtSourceFrame: number;
  event: MagnetConsumedEvent | undefined;
  complete: boolean;
}

type ActiveMagnetAbsorb = AuthoritativeMagnetAbsorb | PredictedMagnetAbsorb;

interface MagnetRecord {
  readonly node: Sprite;
  magnet: MagnetToolState;
  absorb: ActiveMagnetAbsorb | undefined;
  speculationBlocked: boolean;
}

/** 权威 `10001` 地图层；贴图与 70 世界单位缩放均取自 ToolUnit。 */
export class MagnetToolLayer {
  readonly container = new Container();
  private readonly records = new Map<number, MagnetRecord>();
  private authoritativeMagnets = new Map<number, MagnetToolState>();
  private authoritativeSourceFrame = 0;

  constructor(
    private readonly texture: Texture,
    private readonly arenaHalfSize = Number.POSITIVE_INFINITY,
  ) {}

  sync(
    magnets: ReadonlyArray<MagnetToolState>,
    view: ViewBounds,
    authoritativeSourceFrame = 0,
    authoritativeMagnets: ReadonlyArray<MagnetToolState> = magnets,
  ): void {
    this.authoritativeSourceFrame = authoritativeSourceFrame;
    this.authoritativeMagnets = new Map(authoritativeMagnets.map((magnet) => [magnet.id, magnet]));
    const seen = new Set<number>();
    for (const magnet of magnets) {
      seen.add(magnet.id);
      let record = this.records.get(magnet.id);
      if (record === undefined) {
        record = this.createRecord(magnet);
        this.records.set(magnet.id, record);
      }
      record.magnet = magnet;

      const absorb = record.absorb;
      if (
        absorb?.kind === "predicted" &&
        absorb.event === undefined &&
        authoritativeSourceFrame >= Math.ceil(absorb.predictedAtSourceFrame) &&
        this.authoritativeMagnets.has(magnet.id)
      ) {
        record.absorb = undefined;
        record.speculationBlocked = true;
      }
      if (record.absorb !== undefined) {
        this.updateVisibility(record, view);
        continue;
      }
      record.node.position.set(magnet.position.x, magnet.position.y);
      this.updateVisibility(record, view);
    }

    for (const [id, record] of this.records) {
      if (seen.has(id)) continue;
      const absorb = record.absorb;
      const rejectedPrediction =
        absorb?.kind === "predicted" &&
        absorb.event === undefined &&
        authoritativeSourceFrame >= Math.ceil(absorb.predictedAtSourceFrame);
      if (absorb === undefined || rejectedPrediction) {
        record.node.destroy();
        this.records.delete(id);
      }
    }
  }

  consume(event: MagnetConsumedEvent): boolean {
    let record = this.records.get(event.magnet.id);
    if (record === undefined) {
      record = this.createRecord(event.magnet);
      this.records.set(event.magnet.id, record);
    }

    const active = record.absorb;
    if (active?.kind === "predicted") {
      if (active.event !== undefined) return false;
      if (active.playerId === event.playerId) {
        active.event = event;
        record.magnet = event.magnet;
        return true;
      }
      record.absorb = undefined;
      record.speculationBlocked = false;
    } else if (active !== undefined) {
      return false;
    }

    record.magnet = event.magnet;
    record.absorb = { kind: "authoritative", event, state: undefined };
    record.node.visible = true;
    return true;
  }

  predictSelfContacts(
    playerId: string,
    visibleHead: { readonly x: number; readonly y: number },
    collisionHead: { readonly x: number; readonly y: number },
    snakeRadius: number,
    eatDistanceFactor: number,
    presentationSourceFrame: number,
    collisionSourceFrame: number,
  ): Array<MagnetToolState> {
    const predicted: Array<MagnetToolState> = [];
    const contact = (snakeRadius + MAGNET.toolSize / 2) * eatDistanceFactor;
    const guardedContact = Math.max(0, contact - MAGNET_PREDICTION_CONTACT_GUARD);
    for (const record of this.records.values()) {
      if (record.absorb !== undefined) continue;
      const authoritativeMagnet = this.authoritativeMagnets.get(record.magnet.id);
      if (
        authoritativeMagnet === undefined ||
        collisionSourceFrame >= authoritativeMagnet.expiresAtSourceFrame
      ) {
        continue;
      }

      const visibleDeltaX = visibleHead.x - record.node.position.x;
      const visibleDeltaY = visibleHead.y - record.node.position.y;
      const visibleTouching =
        visibleDeltaX * visibleDeltaX + visibleDeltaY * visibleDeltaY < contact * contact;
      if (record.speculationBlocked) {
        if (!visibleTouching) record.speculationBlocked = false;
        continue;
      }
      const collisionPosition = predictMagnetCollisionPosition(
        authoritativeMagnet,
        this.authoritativeSourceFrame,
        collisionSourceFrame,
        this.arenaHalfSize,
      );
      if (collisionPosition === undefined || !visibleTouching) continue;
      const collisionDeltaX = collisionHead.x - collisionPosition.x;
      const collisionDeltaY = collisionHead.y - collisionPosition.y;
      if (
        collisionDeltaX * collisionDeltaX + collisionDeltaY * collisionDeltaY >=
        guardedContact * guardedContact
      ) {
        continue;
      }

      record.absorb = {
        kind: "predicted",
        playerId,
        state: createCollectibleAbsorbTrackingState(
          { x: record.node.position.x, y: record.node.position.y },
          visibleHead,
          presentationSourceFrame,
          MAGNET_PICKUP_SOURCE_FRAME_COUNT,
        ),
        predictedAtSourceFrame: collisionSourceFrame,
        event: undefined,
        complete: false,
      };
      record.node.visible = true;
      predicted.push(authoritativeMagnet);
    }
    return predicted;
  }

  hasPredictedPickup(playerId: string): boolean {
    for (const record of this.records.values()) {
      if (record.absorb?.kind === "predicted" && record.absorb.playerId === playerId) return true;
    }
    return false;
  }

  update(
    view: ViewBounds,
    presentationSourceFrame: (playerId: string) => number | undefined,
    presentationHead: (playerId: string) => { readonly x: number; readonly y: number } | undefined,
  ): Array<MagnetConsumedEvent> {
    const started: Array<MagnetConsumedEvent> = [];
    for (const [id, record] of this.records) {
      const absorb = record.absorb;
      if (absorb === undefined) continue;
      const playerId = absorb.kind === "authoritative" ? absorb.event.playerId : absorb.playerId;
      const sourceFrame = presentationSourceFrame(playerId);
      if (sourceFrame === undefined) {
        this.updateVisibility(record, view);
        continue;
      }

      let sample: CollectibleAbsorbSample;
      if (absorb.kind === "authoritative") {
        if (sourceFrame < absorb.event.sourceFrame) {
          this.updateVisibility(record, view);
          continue;
        }
        if (absorb.state === undefined) {
          absorb.state = createCollectibleAbsorbState(
            { x: record.node.position.x, y: record.node.position.y },
            absorb.event.target,
            sourceFrame,
            MAGNET_PICKUP_SOURCE_FRAME_COUNT,
          );
          started.push(absorb.event);
        }
        sample = sampleCollectibleAbsorbState(absorb.state, sourceFrame);
      } else {
        const currentHead = presentationHead(playerId) ?? absorb.state.target;
        const tracking = advanceCollectibleAbsorbTrackingState(
          absorb.state,
          sourceFrame,
          currentHead,
        );
        absorb.state = tracking.state;
        sample = tracking;
      }
      record.node.position.set(sample.position.x, sample.position.y);
      if (sample.complete) {
        if (absorb.kind === "predicted") {
          absorb.complete = true;
          if (absorb.event === undefined) {
            record.node.visible = false;
            continue;
          }
        }
        record.node.destroy();
        this.records.delete(id);
        continue;
      }
      if (absorb.kind === "predicted") absorb.complete = false;
      this.updateVisibility(record, view);
    }
    return started;
  }

  destroy(): void {
    for (const record of this.records.values()) record.node.destroy();
    this.records.clear();
    this.authoritativeMagnets.clear();
  }

  private createRecord(magnet: MagnetToolState): MagnetRecord {
    const node = new Sprite({ texture: this.texture, anchor: 0.5 });
    const scale = MAGNET.toolSize / Math.max(this.texture.width, this.texture.height);
    node.scale.set(scale);
    node.position.set(magnet.position.x, magnet.position.y);
    this.container.addChild(node);
    return { node, magnet, absorb: undefined, speculationBlocked: false };
  }

  private updateVisibility(record: MagnetRecord, view: ViewBounds): void {
    if (
      record.absorb?.kind === "predicted" &&
      record.absorb.complete &&
      record.absorb.event === undefined
    ) {
      record.node.visible = false;
      return;
    }
    const margin = MAGNET.toolSize;
    record.node.visible =
      record.node.x > view.left - margin &&
      record.node.x < view.right + margin &&
      record.node.y > view.top - margin &&
      record.node.y < view.bottom + margin;
  }
}
