import { Container, Sprite, Text, type Texture } from "pixi.js";
import {
  bodyNodeAt,
  bodyPointIndexes,
  fixedSkinFrameScale,
  internalSkinOrDefault,
  nodeFrameName,
  skinSizeInfo,
  type InternalSkin,
  type SkinNode,
  type SkinSizeInfo,
} from "$lib/game/internal-skins";
import { RENDER } from "../config";
import type { SkinFrameTextures } from "./assets";
import { snakeProtectBounds } from "./snake-protect-effect";
import {
  SNAKE_SPEED_EFFECT,
  accumulateSpeedSourceFrame,
  forEachSpeedPathSample,
  speedPeriodPointCount,
  updateSpeedAnimationState,
} from "./snake-speed-effect";
import {
  SNAKE_MAGNET_LIGHTS,
  SNAKE_MAGNET_RINGS,
  sampleSnakeMagnetLight,
  sampleSnakeMagnetParticle,
  sampleSnakeMagnetRing,
} from "./snake-magnet-effect";

interface Point {
  x: number;
  y: number;
}

export interface SnakeRenderView {
  id: string;
  nickname: string;
  /** 权威内置皮肤 ID。 */
  skinId: number;
  body: ReadonlyArray<Point>;
  angle: number;
  /** 原版带迟滞的当前身体缩放档位。 */
  bodyScale: number;
  boosting: boolean;
  invulnerable: boolean;
  magnetActive: boolean;
  isSelf: boolean;
}

interface ViewBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface SnakeMagnetNodes {
  readonly root: Container;
  readonly groups: ReadonlyArray<ReadonlyArray<Sprite>>;
  readonly rings: ReadonlyArray<Sprite>;
  readonly particle: Sprite | undefined;
  elapsedSourceFrames: number;
  particleElapsedSourceFrames: number;
  wasVisible: boolean;
  lastUpdateMs: number | undefined;
}

interface SnakeNodes {
  root: Container;
  bodyLayer: Container;
  speedLayer: Container;
  protect: Sprite;
  magnet: SnakeMagnetNodes;
  head: Sprite;
  label: Text;
  skin: InternalSkin;
  frames: SkinFrameTextures;
  bodyNodes: Array<Sprite>;
  speedNodes: Array<Sprite>;
  speedPointIndex: number;
  speedFrameRemainder: number;
  speedWasBoosting: boolean;
  lastSpeedUpdateMs: number | undefined;
  /** 皮肤动画的 60 Hz 源帧计数，加速与非加速各自累计。 */
  boostFrameCount: number;
  normalFrameCount: number;
  skinFrameRemainder: number;
  lastSkinUpdateMs: number | undefined;
  lastBody: ReadonlyArray<Point>;
}

/**
 * 昵称贴图的栅格化倍率。
 *
 * Pixi 的 Text 默认按 renderer.resolution 栅格化，并不知道 world 容器上还叠了
 * 相机缩放的放大，所以缩放 > 1 时贴图会被放大采样而发虚。
 * 这里取「最大设备像素比 × 最大相机缩放」，让贴图在任何缩放下都处于缩小采样区间。
 *
 * 必须是静态常量：Text 的 styleKey 含 resolution，常量才能保证贴图只生成一次。
 * 若改成每帧计算，贴图会被反复重建并抖动。
 */
const LABEL_RESOLUTION = Math.ceil(RENDER.maxDevicePixelRatio * RENDER.cameraInitScale);

/**
 * 蛇渲染层：按原版 `NormalRepeat` 规则沿身体路径铺贴片。
 *
 * 每个贴片以采样点为中心，贴图顶边朝向该点的前进方向；
 * 头、身、尾的间距与帧序列全部来自官方皮肤清单。
 */
export class SnakeLayer {
  readonly container = new Container();
  private readonly snakeContainer = new Container();
  private readonly magnetContainer = new Container();
  private readonly protectContainer = new Container();
  private readonly snakes = new Map<string, SnakeNodes>();

  constructor(
    private readonly skinFrames: ReadonlyMap<number, SkinFrameTextures>,
    private readonly speedTexture: Texture,
    private readonly protectTexture: Texture,
    private readonly magnetTextures: ReadonlyArray<Texture> = [],
  ) {
    if (skinFrames.size === 0) throw new Error("Internal skin textures are missing");
    this.container.addChild(
      this.snakeContainer,
      this.magnetContainer,
      this.protectContainer,
    );
  }

  lastBodyOf(id: string): { body: ReadonlyArray<Point>; bodyColor: number } | undefined {
    const nodes = this.snakes.get(id);
    return nodes ? { body: nodes.lastBody, bodyColor: nodes.skin.bodyColor } : undefined;
  }

  update(
    views: ReadonlyArray<SnakeRenderView>,
    view: ViewBounds,
    showNicknames: boolean,
    nowMs: number,
  ): void {
    const seen = new Set<string>();
    for (const snake of views) {
      seen.add(snake.id);
      const nodes = this.ensureNodes(snake.id, snake.skinId);
      this.drawSnake(nodes, snake, view, showNicknames, nowMs);
    }
    for (const [id, nodes] of this.snakes) {
      if (!seen.has(id)) {
        nodes.root.destroy({ children: true });
        nodes.magnet.root.destroy({ children: true });
        nodes.protect.destroy();
        this.snakes.delete(id);
      }
    }
  }

  destroy(): void {
    for (const nodes of this.snakes.values()) {
      nodes.root.destroy({ children: true });
      nodes.magnet.root.destroy({ children: true });
      nodes.protect.destroy();
    }
    this.snakes.clear();
  }

  private ensureNodes(id: string, skinId: number): SnakeNodes {
    const existing = this.snakes.get(id);
    // 皮肤在同一条蛇上换过之后，贴图池必须整体重建。
    if (existing) {
      if (existing.skin.id === internalSkinOrDefault(skinId).id) return existing;
      existing.root.destroy({ children: true });
      existing.magnet.root.destroy({ children: true });
      existing.protect.destroy();
      this.snakes.delete(id);
    }

    const skin = internalSkinOrDefault(skinId);
    const frames = this.skinFrames.get(skin.id);
    if (frames === undefined) throw new Error(`Skin ${skin.id} textures are not loaded`);

    const root = new Container();
    const bodyLayer = new Container();
    const speedLayer = new Container();
    const protect = new Sprite({ texture: this.protectTexture, anchor: 0.5 });
    protect.visible = false;
    const magnet = this.createMagnetEffect();
    const head = new Sprite({ texture: this.frameTexture(frames, skin.head.textures[0]) });
    head.anchor.set(0.5);
    // 流光后于蛇本体绘制，因此覆盖在身体与头部之上。
    root.addChild(bodyLayer, head, speedLayer);

    const label = new Text({
      text: "",
      resolution: LABEL_RESOLUTION,
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 15,
        fontWeight: "600",
        fill: 0x1c2333,
      },
    });
    label.anchor.set(0.5, 1);
    root.addChild(label);

    this.snakeContainer.addChild(root);
    this.magnetContainer.addChild(magnet.root);
    this.protectContainer.addChild(protect);
    const nodes: SnakeNodes = {
      root,
      bodyLayer,
      speedLayer,
      protect,
      magnet,
      head,
      label,
      skin,
      frames,
      bodyNodes: [],
      speedNodes: [],
      speedPointIndex: SNAKE_SPEED_EFFECT.startPointIndex,
      speedFrameRemainder: 0,
      speedWasBoosting: false,
      lastSpeedUpdateMs: undefined,
      boostFrameCount: 0,
      normalFrameCount: 0,
      skinFrameRemainder: 0,
      lastSkinUpdateMs: undefined,
      lastBody: [],
    };
    this.snakes.set(id, nodes);
    return nodes;
  }

  private createMagnetEffect(): SnakeMagnetNodes {
    const root = new Container();
    root.visible = false;
    const groups: Array<Array<Sprite>> = [];
    for (let groupIndex = 0; groupIndex < 2; groupIndex += 1) {
      const group = new Container();
      group.rotation = groupIndex * Math.PI;
      const lights: Array<Sprite> = [];
      for (const definition of SNAKE_MAGNET_LIGHTS) {
        const texture = this.magnetTextures[definition.textureIndex];
        if (texture === undefined) continue;
        const light = new Sprite({ texture, anchor: 0.5 });
        light.rotation = (definition.rotationDegrees / 180) * Math.PI;
        group.addChild(light);
        lights.push(light);
      }
      root.addChild(group);
      groups.push(lights);
    }

    const particleTexture = this.magnetTextures[4];
    const particle =
      particleTexture === undefined
        ? undefined
        : new Sprite({ texture: particleTexture, anchor: 0.5 });
    if (particle !== undefined) {
      particle.blendMode = "add";
      root.addChild(particle);
    }

    const rings: Array<Sprite> = [];
    const ringTexture = this.magnetTextures[0];
    if (ringTexture !== undefined) {
      for (const definition of SNAKE_MAGNET_RINGS) {
        const ring = new Sprite({ texture: ringTexture, anchor: 0.5 });
        ring.rotation = (definition.rotationDegrees / 180) * Math.PI;
        root.addChild(ring);
        rings.push(ring);
      }
    }
    return {
      root,
      groups,
      rings,
      particle,
      elapsedSourceFrames: 0,
      particleElapsedSourceFrames: 0,
      wasVisible: false,
      lastUpdateMs: undefined,
    };
  }

  private syncMagnetEffect(
    nodes: SnakeNodes,
    snake: SnakeRenderView,
    view: ViewBounds,
    bodyWidth: number,
    nowMs: number,
  ): void {
    const head = snake.body[0];
    nodes.magnet.root.visible =
      snake.magnetActive &&
      head !== undefined &&
      head.x > view.left - bodyWidth &&
      head.x < view.right + bodyWidth &&
      head.y > view.top - bodyWidth &&
      head.y < view.bottom + bodyWidth;
    if (!nodes.magnet.root.visible || head === undefined) {
      nodes.magnet.wasVisible = false;
      nodes.magnet.lastUpdateMs = undefined;
      return;
    }
    const elapsedSourceFrames =
      nodes.magnet.lastUpdateMs === undefined
        ? 0
        : (Math.max(0, nowMs - nodes.magnet.lastUpdateMs) / 1_000) * 60;
    nodes.magnet.elapsedSourceFrames += elapsedSourceFrames;
    nodes.magnet.particleElapsedSourceFrames = nodes.magnet.wasVisible
      ? nodes.magnet.particleElapsedSourceFrames + elapsedSourceFrames
      : 0;
    nodes.magnet.wasVisible = true;
    nodes.magnet.lastUpdateMs = nowMs;
    nodes.magnet.root.position.set(head.x, head.y);

    for (const group of nodes.magnet.groups) {
      for (let index = 0; index < group.length; index += 1) {
        const light = group[index];
        const definition = SNAKE_MAGNET_LIGHTS[index];
        if (definition === undefined) continue;
        const sample = sampleSnakeMagnetLight(index, nodes.magnet.elapsedSourceFrames);
        light.position.set(sample.x, sample.y);
        light.alpha = sample.alpha;
        light.scale.set(
          (sample.scale * definition.nodeWidth) / Math.max(1, light.texture.width),
          (sample.scale * definition.nodeHeight) / Math.max(1, light.texture.height),
        );
      }
    }

    for (let index = 0; index < nodes.magnet.rings.length; index += 1) {
      const ring = nodes.magnet.rings[index];
      const definition = SNAKE_MAGNET_RINGS[index];
      if (definition === undefined) continue;
      const sample = sampleSnakeMagnetRing(index, nodes.magnet.elapsedSourceFrames);
      ring.position.set(sample.x, sample.y);
      ring.alpha = sample.alpha;
      ring.scale.set(
        (sample.scale * definition.nodeWidth) / Math.max(1, ring.texture.width),
        (sample.scale * definition.nodeHeight) / Math.max(1, ring.texture.height),
      );
    }

    if (nodes.magnet.particle !== undefined) {
      const sample = sampleSnakeMagnetParticle(nodes.magnet.particleElapsedSourceFrames);
      nodes.magnet.particle.visible = sample.visible;
      nodes.magnet.particle.position.set(sample.x, sample.y);
      nodes.magnet.particle.alpha = sample.alpha;
      nodes.magnet.particle.tint = sample.tint;
      nodes.magnet.particle.rotation = sample.rotation;
      nodes.magnet.particle.scale.set(
        sample.size / Math.max(1, nodes.magnet.particle.texture.width),
      );
    }
  }

  private frameTexture(frames: SkinFrameTextures, name: string): Texture {
    const texture = frames.get(name);
    if (texture === undefined) throw new Error(`Skin frame ${name} is not loaded`);
    return texture;
  }

  /**
   * 推进皮肤动画的源帧计数。
   *
   * 原版按渲染帧累计，并在加速与非加速之间互相清零；
   * 这里把可变刷新率折算到 60 Hz，单次更新最多推进一帧。
   */
  private advanceSkinFrames(nodes: SnakeNodes, boosting: boolean, nowMs: number): void {
    let frameCount: 0 | 1 = 1;
    let frameRemainder = 0;
    if (nodes.lastSkinUpdateMs !== undefined) {
      const elapsedMs = Math.max(0, nowMs - nodes.lastSkinUpdateMs);
      const sourceFrame = accumulateSpeedSourceFrame(nodes.skinFrameRemainder, elapsedMs);
      frameCount = sourceFrame.frameCount;
      frameRemainder = sourceFrame.remainder;
    }
    nodes.lastSkinUpdateMs = nowMs;
    nodes.skinFrameRemainder = frameRemainder;
    if (boosting) {
      nodes.boostFrameCount += frameCount;
      nodes.normalFrameCount = 0;
    } else {
      nodes.normalFrameCount += frameCount;
      nodes.boostFrameCount = 0;
    }
  }

  /** 加速状态下优先使用加速帧组，没有配置时回落到普通帧组。 */
  private nodeTexture(
    nodes: SnakeNodes,
    normal: SkinNode,
    speed: SkinNode | undefined,
    boosting: boolean,
  ): Texture {
    const node = boosting && speed !== undefined ? speed : normal;
    const frameCount =
      boosting && speed !== undefined ? nodes.boostFrameCount : nodes.normalFrameCount;
    return this.frameTexture(nodes.frames, nodeFrameName(node, frameCount));
  }

  private ensureBodyNode(nodes: SnakeNodes, index: number): Sprite {
    const existing = nodes.bodyNodes[index];
    if (existing) return existing;

    const sprite = new Sprite();
    sprite.anchor.set(0.5);
    nodes.bodyLayer.addChild(sprite);
    nodes.bodyNodes.push(sprite);
    return sprite;
  }

  /** 采样点的前进方向：由后一个点指向该点。 */
  private directionAt(body: ReadonlyArray<Point>, index: number, headAngle: number): number {
    if (index <= 0) return headAngle;
    const current = body[Math.min(index, body.length - 1)];
    const behind = body[Math.min(index + 1, body.length - 1)];
    if (behind === current) {
      const ahead = body[Math.max(0, index - 1)];
      return Math.atan2(current.y - ahead.y, current.x - ahead.x) + Math.PI;
    }
    return Math.atan2(current.y - behind.y, current.x - behind.x);
  }

  /**
   * 按原版顺序铺身体与尾巴贴片。
   *
   * 从尾侧向头部遍历，先绘制的节点被后绘制的覆盖，头部始终在最上层。
   */
  private syncBody(
    nodes: SnakeNodes,
    snake: SnakeRenderView,
    size: SkinSizeInfo,
    indexes: ReadonlyArray<number>,
    view: ViewBounds,
  ): void {
    const { body, angle, boosting } = snake;
    const skin = nodes.skin;
    const hasTail = skin.tail !== null;
    const total = indexes.length + (hasTail ? 1 : 0);
    const margin = Math.max(size.bodyWidth, size.headHeight, size.tailHeight);
    let renderIndex = 0;

    for (let order = total - 1; order >= 1; order -= 1) {
      const isTail = hasTail && order === total - 1;
      const pointIndex = isTail ? indexes[indexes.length - 1] : indexes[order];
      const point = body[Math.min(pointIndex, body.length - 1)];
      if (point === undefined) continue;
      const direction = this.directionAt(body, pointIndex, angle);

      let x = point.x;
      let y = point.y;
      let texture: Texture;
      let renderWidth: number;
      let renderHeight: number;
      if (isTail && skin.tail !== null) {
        // 尾巴沿前进方向反向偏移固定的采样点数。
        const offset = size.pointDistance * size.tailPointDistance;
        x -= offset * Math.cos(direction);
        y -= offset * Math.sin(direction);
        texture = this.nodeTexture(nodes, skin.tail, skin.tailSpeed ?? undefined, boosting);
        renderWidth = size.tailWidth;
        renderHeight = size.tailHeight;
      } else {
        const bodyIndex = isTail ? order - 1 : order;
        const normal = bodyNodeAt(skin.body, bodyIndex);
        const speed = skin.bodySpeed.length > 0 ? bodyNodeAt(skin.bodySpeed, bodyIndex) : undefined;
        texture = this.nodeTexture(nodes, normal, speed, boosting);
        renderWidth = size.bodyWidth;
        renderHeight = size.bodyHeight;
      }

      if (
        x + margin < view.left ||
        x - margin > view.right ||
        y + margin < view.top ||
        y - margin > view.bottom
      ) {
        continue;
      }

      const sprite = this.ensureBodyNode(nodes, renderIndex);
      sprite.visible = true;
      sprite.texture = texture;
      sprite.position.set(x, y);
      // 贴图顶边朝向前进方向；引擎里 angle=0 指向 +X。
      sprite.rotation = direction + Math.PI / 2;
      const scale = fixedSkinFrameScale(renderWidth, renderHeight, texture.width, texture.height);
      sprite.scale.set(scale.x, scale.y);
      renderIndex += 1;
    }

    for (let index = renderIndex; index < nodes.bodyNodes.length; index += 1) {
      nodes.bodyNodes[index].visible = false;
    }
  }

  private syncHead(nodes: SnakeNodes, snake: SnakeRenderView, size: SkinSizeInfo): void {
    const head = snake.body[0];
    const skin = nodes.skin;
    nodes.head.texture = this.nodeTexture(
      nodes,
      skin.head,
      skin.headSpeed ?? undefined,
      snake.boosting,
    );
    nodes.head.position.set(head.x, head.y);
    nodes.head.rotation = snake.angle + Math.PI / 2;
    const scale = fixedSkinFrameScale(
      size.headWidth,
      size.headHeight,
      nodes.head.texture.width,
      nodes.head.texture.height,
    );
    nodes.head.scale.set(scale.x, scale.y);
  }

  private ensureSpeedNode(nodes: SnakeNodes, index: number): Sprite {
    const existing = nodes.speedNodes[index];
    if (existing) return existing;

    const speed = new Sprite({ texture: this.speedTexture, anchor: 0.5 });
    nodes.speedLayer.addChild(speed);
    nodes.speedNodes.push(speed);
    return speed;
  }

  private updateSpeedAnimation(
    nodes: SnakeNodes,
    boosting: boolean,
    bodyScale: number,
    nowMs: number,
  ): void {
    const elapsedMs =
      nodes.lastSpeedUpdateMs === undefined ? 0 : Math.max(0, nowMs - nodes.lastSpeedUpdateMs);
    nodes.lastSpeedUpdateMs = nowMs;
    const next = updateSpeedAnimationState(
      {
        pointIndex: nodes.speedPointIndex,
        frameRemainder: nodes.speedFrameRemainder,
        wasBoosting: nodes.speedWasBoosting,
      },
      boosting,
      bodyScale,
      elapsedMs,
    );
    nodes.speedPointIndex = next.pointIndex;
    nodes.speedFrameRemainder = next.frameRemainder;
    nodes.speedWasBoosting = next.wasBoosting;
  }

  private syncSpeedEffect(
    nodes: SnakeNodes,
    snake: SnakeRenderView,
    view: ViewBounds,
    bodyScale: number,
  ): void {
    if (!snake.boosting || snake.body.length < 2) {
      nodes.speedLayer.visible = false;
      return;
    }
    nodes.speedLayer.visible = true;

    const effectWidth = SNAKE_SPEED_EFFECT.frameWidth * bodyScale;
    const effectLength = SNAKE_SPEED_EFFECT.frameLength * bodyScale;
    const spacing = speedPeriodPointCount(bodyScale) * SNAKE_SPEED_EFFECT.pointDistance;
    const textureWidth = Math.max(1, this.speedTexture.width);
    const textureHeight = Math.max(1, this.speedTexture.height);
    let renderIndex = 0;

    forEachSpeedPathSample(
      snake.body,
      nodes.speedPointIndex * SNAKE_SPEED_EFFECT.pointDistance,
      spacing,
      (x, y, forwardAngle) => {
        const rotation = forwardAngle + Math.PI / 2;
        const halfWidth = effectWidth / 2;
        const halfLength = effectLength / 2;
        const extentX =
          Math.abs(Math.cos(rotation)) * halfWidth + Math.abs(Math.sin(rotation)) * halfLength;
        const extentY =
          Math.abs(Math.sin(rotation)) * halfWidth + Math.abs(Math.cos(rotation)) * halfLength;
        if (
          x + extentX < view.left ||
          x - extentX > view.right ||
          y + extentY < view.top ||
          y - extentY > view.bottom
        ) {
          return;
        }

        const speed = this.ensureSpeedNode(nodes, renderIndex);
        speed.visible = true;
        speed.position.set(x, y);
        // speed_up 图块顶部是贴片前端。
        speed.rotation = rotation;
        speed.scale.set(effectWidth / textureWidth, effectLength / textureHeight);
        renderIndex += 1;
      },
    );

    for (let index = renderIndex; index < nodes.speedNodes.length; index += 1) {
      nodes.speedNodes[index].visible = false;
    }
  }

  private syncProtectEffect(nodes: SnakeNodes, snake: SnakeRenderView, view: ViewBounds): void {
    const bounds = snake.invulnerable ? snakeProtectBounds(snake.body) : undefined;
    if (
      bounds === undefined ||
      bounds.centerX + bounds.halfSize < view.left ||
      bounds.centerX - bounds.halfSize > view.right ||
      bounds.centerY + bounds.halfSize < view.top ||
      bounds.centerY - bounds.halfSize > view.bottom
    ) {
      nodes.protect.visible = false;
      return;
    }

    nodes.protect.visible = true;
    nodes.protect.position.set(bounds.centerX, bounds.centerY);
    nodes.protect.scale.set(
      bounds.size / Math.max(1, this.protectTexture.width),
      bounds.size / Math.max(1, this.protectTexture.height),
    );
  }

  private drawSnake(
    nodes: SnakeNodes,
    snake: SnakeRenderView,
    view: ViewBounds,
    showNicknames: boolean,
    nowMs: number,
  ): void {
    const { body, bodyScale } = snake;
    this.advanceSkinFrames(nodes, snake.boosting, nowMs);
    this.updateSpeedAnimation(nodes, snake.boosting, bodyScale, nowMs);
    if (body.length === 0) {
      nodes.root.visible = false;
      nodes.protect.visible = false;
      nodes.magnet.root.visible = false;
      nodes.magnet.wasVisible = false;
      nodes.magnet.lastUpdateMs = undefined;
      return;
    }
    nodes.lastBody = body;
    nodes.root.visible = true;
    const size = skinSizeInfo(nodes.skin, bodyScale);
    this.syncProtectEffect(nodes, snake, view);
    this.syncMagnetEffect(nodes, snake, view, size.bodyWidth, nowMs);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of body) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
    const margin = Math.max(size.bodyWidth, size.headHeight);
    const bodyVisible = !(
      maxX < view.left - margin ||
      minX > view.right + margin ||
      maxY < view.top - margin ||
      minY > view.bottom + margin
    );
    nodes.bodyLayer.visible = bodyVisible;
    nodes.head.visible = bodyVisible;
    if (bodyVisible) {
      this.syncBody(nodes, snake, size, bodyPointIndexes(size, body.length), view);
      this.syncHead(nodes, snake, size);
    }
    this.syncSpeedEffect(nodes, snake, view, bodyScale);

    nodes.label.visible = bodyVisible && showNicknames;
    if (nodes.label.visible) {
      const head = body[0];
      nodes.label.text = snake.nickname;
      nodes.label.position.set(head.x, head.y - size.headHeight * 1.15);
    }
  }
}
