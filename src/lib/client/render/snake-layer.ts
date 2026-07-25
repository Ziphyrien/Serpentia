import { Container, Graphics, GraphicsContext, Text } from "pixi.js";
import { skinForPlayer, type SkinDefinition } from "../config";

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
  shade: Graphics;
  body: Graphics;
}

interface SnakeNodes {
  root: Container;
  bodyLayer: Container;
  head: Graphics;
  label: Text;
  skin: SkinDefinition;
  beadNodes: Array<BeadNodes>;
  lastBody: ReadonlyArray<Point>;
}

interface Bead {
  x: number;
  y: number;
  r: number;
  forwardX: number;
  forwardY: number;
}

const BEAD_CIRCLE_RADIUS = 32;

function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (((ar + (br - ar) * t) | 0) << 16) |
    (((ag + (bg - ag) * t) | 0) << 8) |
    ((ab + (bb - ab) * t) | 0)
  );
}

/**
 * 蛇渲染层：经典《贪吃蛇大作战》式扁平圆节身体与外凸双眼。
 * 身体只复用程序化圆形几何并更新变换，不使用贴图。
 */
export class SnakeLayer {
  readonly container = new Container();
  private snakes = new Map<string, SnakeNodes>();
  private readonly beads: Array<Bead> = [];
  private readonly beadCircle = new GraphicsContext()
    .circle(0, 0, BEAD_CIRCLE_RADIUS)
    .fill(0xffffff);

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
    this.beadCircle.destroy();
  }

  private ensureNodes(id: string): SnakeNodes {
    let nodes = this.snakes.get(id);
    if (nodes) return nodes;

    const skin = skinForPlayer(id);
    const root = new Container();
    const bodyLayer = new Container();
    const head = new Graphics();
    root.addChild(bodyLayer, head);

    const label = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 15,
        fontWeight: "600",
        fill: 0xffffff,
        stroke: { color: 0x0b1020, width: 4, join: "round" },
      },
    });
    label.anchor.set(0.5, 1);
    root.addChild(label);

    this.container.addChild(root);
    nodes = { root, bodyLayer, head, label, skin, beadNodes: [], lastBody: [] };
    this.snakes.set(id, nodes);
    return nodes;
  }

  private collectBeads(
    body: ReadonlyArray<Point>,
    radius: number,
    view: ViewBounds,
  ): Array<Bead> {
    const beads = this.beads;
    beads.length = 0;

    let totalLength = 0;
    for (let index = 1; index < body.length; index += 1) {
      totalLength += Math.hypot(
        body[index].x - body[index - 1].x,
        body[index].y - body[index - 1].y,
      );
    }
    if (totalLength <= 0) return beads;

    const spacing = Math.max(5, radius * 1.05);
    const margin = radius * 3;
    let target = 0;
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
          beads.push({
            x,
            y,
            r: radius,
            forwardX: -deltaX / segmentLength,
            forwardY: -deltaY / segmentLength,
          });
        }
        target += spacing;
      }
      travelled += segmentLength;
      startX = endX;
      startY = endY;
    }
    return beads;
  }

  private ensureBeadNodes(nodes: SnakeNodes, index: number): BeadNodes {
    const existing = nodes.beadNodes[index];
    if (existing) return existing;

    const shade = new Graphics(this.beadCircle);
    shade.tint = mixColor(nodes.skin.body, nodes.skin.dark, 0.45);
    const body = new Graphics(this.beadCircle);
    body.tint = nodes.skin.body;
    nodes.bodyLayer.addChild(shade, body);

    const beadNodes = { shade, body };
    nodes.beadNodes.push(beadNodes);
    return beadNodes;
  }

  private syncBeads(nodes: SnakeNodes, beads: ReadonlyArray<Bead>): void {
    for (let renderIndex = 0; renderIndex < beads.length; renderIndex += 1) {
      const bead = beads[beads.length - 1 - renderIndex];
      const beadNodes = this.ensureBeadNodes(nodes, renderIndex);
      beadNodes.shade.visible = true;
      beadNodes.body.visible = true;

      beadNodes.shade.position.set(bead.x, bead.y);
      beadNodes.shade.scale.set(bead.r / BEAD_CIRCLE_RADIUS);
      beadNodes.body.position.set(
        bead.x + bead.forwardX * bead.r * 0.16,
        bead.y + bead.forwardY * bead.r * 0.16,
      );
      beadNodes.body.scale.set((bead.r * 0.9) / BEAD_CIRCLE_RADIUS);
    }

    for (let index = beads.length; index < nodes.beadNodes.length; index += 1) {
      nodes.beadNodes[index].shade.visible = false;
      nodes.beadNodes[index].body.visible = false;
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
    const radius = snake.radius;
    if (
      maxX < view.left - radius ||
      minX > view.right + radius ||
      maxY < view.top - radius ||
      minY > view.bottom + radius
    ) {
      nodes.root.visible = false;
      return;
    }
    nodes.root.visible = true;

    nodes.head.clear();
    this.syncBeads(nodes, this.collectBeads(body, radius, view));
    this.drawHead(nodes, snake);

    nodes.label.visible = showNicknames;
    if (showNicknames) {
      const head = body[0];
      nodes.label.text = snake.nickname;
      nodes.label.position.set(head.x, head.y - radius * 2.3);
    }

    nodes.root.alpha = snake.invulnerable ? 0.55 + Math.sin(nowMs * 0.02) * 0.2 : 1;
  }

  private drawHead(nodes: SnakeNodes, snake: SnakeRenderView): void {
    const gfx = nodes.head;
    const skin = nodes.skin;
    const head = snake.body[0];
    const forwardX = Math.cos(snake.angle);
    const forwardY = Math.sin(snake.angle);
    const perpX = -forwardY;
    const perpY = forwardX;
    const radius = snake.radius;

    gfx.circle(head.x, head.y, radius).fill(skin.body);

    const eyeForward = radius * 0.58;
    const eyeSide = radius * 0.43;
    const eyeRadius = radius * 0.36;
    for (const side of [-1, 1]) {
      const eyeX = head.x + forwardX * eyeForward + perpX * side * eyeSide;
      const eyeY = head.y + forwardY * eyeForward + perpY * side * eyeSide;
      gfx.circle(eyeX, eyeY, eyeRadius).fill(0xffffff);
      const pupilX = eyeX + forwardX * eyeRadius * 0.18;
      const pupilY = eyeY + forwardY * eyeRadius * 0.18;
      gfx.circle(pupilX, pupilY, eyeRadius * 0.52).fill(0x111111);
      gfx
        .circle(pupilX - eyeRadius * 0.13, pupilY - eyeRadius * 0.15, eyeRadius * 0.13)
        .fill(0xffffff);
    }
  }
}
