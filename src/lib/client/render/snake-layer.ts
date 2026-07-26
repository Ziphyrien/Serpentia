import { Container, Sprite, Text } from "pixi.js";
import { RENDER, skinForPlayer, type SkinDefinition } from "../config";
import type { SnakeSkinTextures } from "./assets";

interface Point {
  x: number;
  y: number;
}

export interface SnakeRenderView {
  id: string;
  nickname: string;
  body: ReadonlyArray<Point>;
  angle: number;
  radius: number;
  boosting: boolean;
  invulnerable: boolean;
  isSelf: boolean;
}

interface ViewBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface BeadNodes {
  body: Sprite;
  /** 加速高光：与身体同贴图、同位置，用加色混合把该节点亮起来。 */
  pulse: Sprite;
}

interface SnakeNodes {
  root: Container;
  bodyLayer: Container;
  head: Sprite;
  headPulse: Sprite;
  label: Text;
  skin: SkinDefinition;
  textures: SnakeSkinTextures;
  beadNodes: Array<BeadNodes>;
  lastBody: ReadonlyArray<Point>;
}

interface Bead {
  x: number;
  y: number;
  r: number;
  /** 沿身体的累计弧长，用于取加速波相位；与视口裁剪无关。 */
  distance: number;
}

/** 加速波长，以身体节点数计。 */
const BOOST_WAVE_BEADS = 6;
/** 加速波沿身体推进的速度（世界单位／秒）。 */
const BOOST_WAVE_SPEED = 520;
const BOOST_PULSE_ALPHA = 0.5;
const BOOST_PULSE_SCALE = 0.12;

/**
 * 加速脉冲强度（0..1）：沿身体推进的正弦波，波峰朝头部移动。
 *
 * 相位取自累计弧长而不是节点序号，所以视口裁掉尾部时波形不会跳变。
 * 平方一次让波谷更平，读起来是一束束能量而不是整条蛇整体明暗呼吸。
 */
function boostWave(distance: number, radius: number, nowMs: number): number {
  const wavelength = Math.max(1, radius * 1.4 * BOOST_WAVE_BEADS);
  const travelled = (nowMs / 1000) * BOOST_WAVE_SPEED;
  const raw = Math.sin(((distance + travelled) / wavelength) * Math.PI * 2);
  return raw <= 0 ? 0 : raw * raw;
}

/**
 * 昵称贴图的栅格化倍率。
 *
 * Pixi 的 Text 默认按 renderer.resolution 栅格化，并不知道 world 容器上还叠了
 * camera.zoom 的放大，所以 zoom > 1 时贴图会被放大采样而发虚。
 * 这里取「最大设备像素比 × 最大相机缩放」，让贴图在任何缩放下都处于缩小采样区间。
 *
 * 必须是静态常量：Text 的 styleKey 含 resolution，常量才能保证贴图只生成一次。
 * 若改成每帧计算，贴图会被反复重建并抖动。
 */
const LABEL_RESOLUTION = Math.ceil(RENDER.maxDevicePixelRatio * RENDER.zoomAtBaseRadius);

/**
 * 蛇渲染层：使用 Snake-Demo 游戏场景实际引用的四套头部与身体 Sprite。
 * 尺寸关系、朝向和离散身体间距沿用原 Unity 实现。
 */
export class SnakeLayer {
  readonly container = new Container();
  private readonly snakes = new Map<string, SnakeNodes>();
  private readonly beads: Array<Bead> = [];

  constructor(private readonly skinTextures: ReadonlyArray<SnakeSkinTextures>) {
    if (skinTextures.length === 0) throw new Error("Snake-Demo snake textures are missing");
  }

  lastBodyOf(id: string): { body: ReadonlyArray<Point>; skin: SkinDefinition } | undefined {
    const nodes = this.snakes.get(id);
    return nodes ? { body: nodes.lastBody, skin: nodes.skin } : undefined;
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
      const nodes = this.ensureNodes(snake.id);
      this.drawSnake(nodes, snake, view, showNicknames, nowMs);
    }
    for (const [id, nodes] of this.snakes) {
      if (!seen.has(id)) {
        nodes.root.destroy({ children: true });
        this.snakes.delete(id);
      }
    }
  }

  destroy(): void {
    for (const nodes of this.snakes.values()) nodes.root.destroy({ children: true });
    this.snakes.clear();
  }

  private ensureNodes(id: string): SnakeNodes {
    const existing = this.snakes.get(id);
    if (existing) return existing;

    const skin = skinForPlayer(id);
    const textures = this.skinTextures[skin.textureIndex] ?? this.skinTextures[0];
    if (!textures) throw new Error("Snake-Demo snake texture lookup failed");

    const root = new Container();
    const bodyLayer = new Container();
    const head = new Sprite({ texture: textures.head, anchor: 0.5 });
    // 加速高光复用同一张贴图并叠加，亮度只在原有轮廓内增强，不外溢成光斑。
    const headPulse = new Sprite({
      texture: textures.head,
      anchor: 0.5,
      blendMode: "add",
      visible: false,
    });
    root.addChild(bodyLayer, head, headPulse);

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

    this.container.addChild(root);
    const nodes = {
      root,
      bodyLayer,
      head,
      headPulse,
      label,
      skin,
      textures,
      beadNodes: [],
      lastBody: [],
    };
    this.snakes.set(id, nodes);
    return nodes;
  }

  private collectBeads(body: ReadonlyArray<Point>, radius: number, view: ViewBounds): Array<Bead> {
    const beads = this.beads;
    beads.length = 0;

    // 原版每 5 个 FixedUpdate 放置一节；移动步长约 0.08、身体直径约 0.5。
    const spacing = Math.max(5, radius * 1.4);
    const margin = radius * 3;
    let target = spacing;
    let travelled = 0;
    let startX = body[0].x;
    let startY = body[0].y;

    for (let index = 1; index < body.length; index += 1) {
      const endX = body[index].x;
      const endY = body[index].y;
      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const segmentLength = Math.hypot(deltaX, deltaY);
      while (segmentLength > 0 && target <= travelled + segmentLength) {
        const t = (target - travelled) / segmentLength;
        const x = startX + deltaX * t;
        const y = startY + deltaY * t;
        if (
          x > view.left - margin &&
          x < view.right + margin &&
          y > view.top - margin &&
          y < view.bottom + margin
        ) {
          beads.push({ x, y, r: radius, distance: target });
        }
        target += spacing;
      }
      travelled += segmentLength;
      startX = endX;
      startY = endY;
    }
    return beads;
  }

  private ensureBeadNode(nodes: SnakeNodes, index: number): BeadNodes {
    const existing = nodes.beadNodes[index];
    if (existing) return existing;

    const body = new Sprite({ texture: nodes.textures.body, anchor: 0.5 });
    const pulse = new Sprite({
      texture: nodes.textures.body,
      anchor: 0.5,
      blendMode: "add",
      visible: false,
    });
    nodes.bodyLayer.addChild(body, pulse);
    const beadNodes = { body, pulse };
    nodes.beadNodes.push(beadNodes);
    return beadNodes;
  }

  private syncBeads(
    nodes: SnakeNodes,
    beads: ReadonlyArray<Bead>,
    boosting: boolean,
    nowMs: number,
  ): void {
    const textureDiameter = Math.max(nodes.textures.body.width, nodes.textures.body.height);
    for (let renderIndex = 0; renderIndex < beads.length; renderIndex += 1) {
      // 尾部先画，靠近头部的身体覆盖在上方，与原 SpriteRenderer 层级一致。
      const bead = beads[beads.length - 1 - renderIndex];
      const node = this.ensureBeadNode(nodes, renderIndex);
      const scale = (bead.r * 2) / textureDiameter;
      node.body.visible = true;
      node.body.position.set(bead.x, bead.y);
      node.body.scale.set(scale);

      const wave = boosting ? boostWave(bead.distance, bead.r, nowMs) : 0;
      node.pulse.visible = wave > 0.01;
      if (node.pulse.visible) {
        node.pulse.position.set(bead.x, bead.y);
        node.pulse.scale.set(scale * (1 + BOOST_PULSE_SCALE * wave));
        node.pulse.alpha = BOOST_PULSE_ALPHA * wave;
      }
    }

    for (let index = beads.length; index < nodes.beadNodes.length; index += 1) {
      nodes.beadNodes[index].body.visible = false;
      nodes.beadNodes[index].pulse.visible = false;
    }
  }

  private drawSnake(
    nodes: SnakeNodes,
    snake: SnakeRenderView,
    view: ViewBounds,
    showNicknames: boolean,
    nowMs: number,
  ): void {
    const { body } = snake;
    if (body.length === 0) {
      nodes.root.visible = false;
      return;
    }
    nodes.lastBody = body;

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
    const margin = snake.radius * 2;
    if (
      maxX < view.left - margin ||
      minX > view.right + margin ||
      maxY < view.top - margin ||
      minY > view.bottom + margin
    ) {
      nodes.root.visible = false;
      return;
    }
    nodes.root.visible = true;

    const beads = this.collectBeads(body, snake.radius, view);
    this.syncBeads(nodes, beads, snake.boosting, nowMs);
    this.syncHead(nodes, snake, nowMs);

    nodes.label.visible = showNicknames;
    if (showNicknames) {
      const head = body[0];
      nodes.label.text = snake.nickname;
      nodes.label.position.set(head.x, head.y - snake.radius * 2.3);
    }

    nodes.root.alpha = snake.invulnerable ? 0.55 + Math.sin(nowMs * 0.02) * 0.2 : 1;
  }

  private syncHead(nodes: SnakeNodes, snake: SnakeRenderView, nowMs: number): void {
    const head = snake.body[0];
    const bodyTextureDiameter = Math.max(nodes.textures.body.width, nodes.textures.body.height);
    const scale = (snake.radius * 2) / bodyTextureDiameter;
    // 原 Sprite 朝上；当前引擎的 angle=0 朝右，因此顺时针补偿 90°。
    const rotation = snake.angle + Math.PI / 2;
    nodes.head.position.set(head.x, head.y);
    nodes.head.rotation = rotation;
    nodes.head.scale.set(scale);

    // 头部取波的起点（弧长 0），所以每束能量推到头部时正好在这里亮一下。
    const wave = snake.boosting ? boostWave(0, snake.radius, nowMs) : 0;
    nodes.headPulse.visible = wave > 0.01;
    if (nodes.headPulse.visible) {
      nodes.headPulse.position.set(head.x, head.y);
      nodes.headPulse.rotation = rotation;
      nodes.headPulse.scale.set(scale * (1 + BOOST_PULSE_SCALE * wave));
      nodes.headPulse.alpha = BOOST_PULSE_ALPHA * wave;
    }
  }
}
