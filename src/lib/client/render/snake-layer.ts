import { Container, Sprite, Text } from "pixi.js";
import { skinForPlayer, type SkinDefinition } from "../config";
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

interface SnakeNodes {
  root: Container;
  bodyLayer: Container;
  head: Sprite;
  label: Text;
  skin: SkinDefinition;
  textures: SnakeSkinTextures;
  beadNodes: Array<Sprite>;
  lastBody: ReadonlyArray<Point>;
}

interface Bead {
  x: number;
  y: number;
  r: number;
}

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
    root.addChild(bodyLayer, head);

    const label = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 15,
        fontWeight: "600",
        // 场地为浅色，因此字身用深色、描边用白色。
        // 反过来（白字深描边）会让字身融进场地，只剩描边可见，看起来发糊。
        fill: 0x1c2333,
        stroke: { color: 0xffffff, width: 4, join: "round" },
      },
    });
    label.anchor.set(0.5, 1);
    root.addChild(label);

    this.container.addChild(root);
    const nodes = {
      root,
      bodyLayer,
      head,
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
          beads.push({ x, y, r: radius });
        }
        target += spacing;
      }
      travelled += segmentLength;
      startX = endX;
      startY = endY;
    }
    return beads;
  }

  private ensureBeadNode(nodes: SnakeNodes, index: number): Sprite {
    const existing = nodes.beadNodes[index];
    if (existing) return existing;

    const bead = new Sprite({ texture: nodes.textures.body, anchor: 0.5 });
    nodes.bodyLayer.addChild(bead);
    nodes.beadNodes.push(bead);
    return bead;
  }

  private syncBeads(nodes: SnakeNodes, beads: ReadonlyArray<Bead>): void {
    const textureDiameter = Math.max(nodes.textures.body.width, nodes.textures.body.height);
    for (let renderIndex = 0; renderIndex < beads.length; renderIndex += 1) {
      // 尾部先画，靠近头部的身体覆盖在上方，与原 SpriteRenderer 层级一致。
      const bead = beads[beads.length - 1 - renderIndex];
      const node = this.ensureBeadNode(nodes, renderIndex);
      node.visible = true;
      node.position.set(bead.x, bead.y);
      node.scale.set((bead.r * 2) / textureDiameter);
    }

    for (let index = beads.length; index < nodes.beadNodes.length; index += 1) {
      nodes.beadNodes[index].visible = false;
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

    this.syncBeads(nodes, this.collectBeads(body, snake.radius, view));
    this.syncHead(nodes, snake);

    nodes.label.visible = showNicknames;
    if (showNicknames) {
      const head = body[0];
      nodes.label.text = snake.nickname;
      nodes.label.position.set(head.x, head.y - snake.radius * 2.3);
    }

    nodes.root.alpha = snake.invulnerable ? 0.55 + Math.sin(nowMs * 0.02) * 0.2 : 1;
  }

  private syncHead(nodes: SnakeNodes, snake: SnakeRenderView): void {
    const head = snake.body[0];
    const bodyTextureDiameter = Math.max(nodes.textures.body.width, nodes.textures.body.height);
    const scale = (snake.radius * 2) / bodyTextureDiameter;
    nodes.head.position.set(head.x, head.y);
    // 原 Sprite 朝上；当前引擎的 angle=0 朝右，因此顺时针补偿 90°。
    nodes.head.rotation = snake.angle + Math.PI / 2;
    nodes.head.scale.set(scale);
  }
}
