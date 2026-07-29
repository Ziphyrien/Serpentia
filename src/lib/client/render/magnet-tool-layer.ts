import { Container, Sprite, type Texture } from "pixi.js";
import type { MagnetConsumedEvent, MagnetToolState } from "$lib/protocol";
import { MAGNET } from "$lib/game/magnet";
import {
  createFoodAbsorbState,
  sampleFoodAbsorbState,
  type FoodAbsorbState,
} from "./food-absorb-effect";

interface ViewBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface MagnetRecord {
  readonly node: Sprite;
  magnet: MagnetToolState;
  event: MagnetConsumedEvent | undefined;
  absorb: FoodAbsorbState | undefined;
}

/** 权威 `10001` 地图层；贴图与 70 世界单位缩放均取自原版 ToolUnit。 */
export class MagnetToolLayer {
  readonly container = new Container();
  private readonly records = new Map<number, MagnetRecord>();

  constructor(private readonly texture: Texture) {}

  sync(magnets: ReadonlyArray<MagnetToolState>, view: ViewBounds): void {
    const seen = new Set<number>();
    for (const magnet of magnets) {
      seen.add(magnet.id);
      let record = this.records.get(magnet.id);
      if (record === undefined) {
        record = this.createRecord(magnet);
        this.records.set(magnet.id, record);
      }
      record.magnet = magnet;
      if (record.event === undefined)
        record.node.position.set(magnet.position.x, magnet.position.y);
      this.updateVisibility(record, view);
    }
    for (const [id, record] of this.records) {
      if (!seen.has(id) && record.event === undefined) {
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
    if (record.event !== undefined) return false;
    record.event = event;
    record.absorb = undefined;
    record.node.position.set(event.magnet.position.x, event.magnet.position.y);
    record.node.visible = true;
    return true;
  }

  update(
    view: ViewBounds,
    presentationSourceFrame: (playerId: string) => number | undefined,
  ): Array<MagnetConsumedEvent> {
    const started: Array<MagnetConsumedEvent> = [];
    for (const [id, record] of this.records) {
      const event = record.event;
      if (event === undefined) continue;
      const sourceFrame = presentationSourceFrame(event.playerId);
      if (sourceFrame === undefined || sourceFrame < event.sourceFrame) continue;
      if (record.absorb === undefined) {
        record.absorb = createFoodAbsorbState(event.magnet.position, event.target, sourceFrame);
        started.push(event);
      }
      const sample = sampleFoodAbsorbState(record.absorb, sourceFrame);
      record.node.position.set(sample.position.x, sample.position.y);
      if (sample.complete) {
        record.node.destroy();
        this.records.delete(id);
      } else {
        this.updateVisibility(record, view);
      }
    }
    return started;
  }

  destroy(): void {
    for (const record of this.records.values()) record.node.destroy();
    this.records.clear();
  }

  private createRecord(magnet: MagnetToolState): MagnetRecord {
    const node = new Sprite({ texture: this.texture, anchor: 0.5 });
    const scale = MAGNET.toolSize / Math.max(this.texture.width, this.texture.height);
    node.scale.set(scale);
    node.position.set(magnet.position.x, magnet.position.y);
    this.container.addChild(node);
    return { node, magnet, event: undefined, absorb: undefined };
  }

  private updateVisibility(record: MagnetRecord, view: ViewBounds): void {
    const margin = MAGNET.toolSize;
    record.node.visible =
      record.node.x > view.left - margin &&
      record.node.x < view.right + margin &&
      record.node.y > view.top - margin &&
      record.node.y < view.bottom + margin;
  }
}
