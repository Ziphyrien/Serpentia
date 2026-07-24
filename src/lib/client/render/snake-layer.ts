import { Container, Graphics, Sprite, Text } from "pixi.js";
import { skinForPlayer, type SkinDefinition } from "../config";
import type { GameTextures } from "./assets";

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
  body: Graphics;
  head: Sprite | undefined;
  headFallback: Graphics | undefined;
  label: Text;
  skin: SkinDefinition;
  lastBody: ReadonlyArray<Point>;
}

/**
 * 蛇渲染层：平滑描边身体 + 生成头部贴图 + 昵称标签。
 * 每条蛇一个容器，按需创建/销毁。
 */
export class SnakeLayer {
  readonly container = new Container();
  private snakes = new Map<string, SnakeNodes>();

  constructor(private readonly textures: GameTextures) {}

  /** 供死亡特效读取蛇最后的外形。 */
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
    let nodes = this.snakes.get(id);
    if (nodes) return nodes;
    const skin = skinForPlayer(id);
    const root = new Container();
    const body = new Graphics();
    root.addChild(body);

    const headTexture = this.textures.heads.get(skin.id);
    let head: Sprite | undefined;
    let headFallback: Graphics | undefined;
    if (headTexture) {
      head = new Sprite(headTexture);
      head.anchor.set(skin.headGeometry.centerX, skin.headGeometry.centerY);
      root.addChild(head);
    } else {
      headFallback = new Graphics();
      headFallback.circle(0, 0, 10).fill(skin.body);
      // 眼睛（朝向 +y，与贴图一致）
      headFallback.circle(-4.5, 4, 3).fill(0xffffff);
      headFallback.circle(4.5, 4, 3).fill(0xffffff);
      headFallback.circle(-4.5, 4.8, 1.6).fill(0x1a1a2e);
      headFallback.circle(4.5, 4.8, 1.6).fill(0x1a1a2e);
      root.addChild(headFallback);
    }

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
    nodes = { root, body, head, headFallback, label, skin, lastBody: [] };
    this.snakes.set(id, nodes);
    return nodes;
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

    // 视口粗裁剪：整条蛇包围盒
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

    const skin = nodes.skin;
    const gfx = nodes.body;
    gfx.clear();

    // 只画视野内（附近）的点，减少 Graphics 负载
    const margin = radius * 3;
    const points: Array<Point> = [];
    for (const point of body) {
      if (
        point.x > view.left - margin &&
        point.x < view.right + margin &&
        point.y > view.top - margin &&
        point.y < view.bottom + margin
      ) {
        points.push(point);
      }
    }
    if (points.length >= 2) {
      if (snake.boosting) {
        gfx.poly(points, false).stroke({
          width: radius * 2 + 12,
          color: skin.light,
          alpha: 0.3,
          cap: "round",
          join: "round",
        });
      }
      gfx.poly(points, false).stroke({
        width: radius * 2 + 5,
        color: skin.dark,
        cap: "round",
        join: "round",
      });
      gfx.poly(points, false).stroke({
        width: radius * 2,
        color: skin.body,
        cap: "round",
        join: "round",
      });
      // 背部高光
      gfx.poly(points, false).stroke({
        width: radius * 0.85,
        color: skin.light,
        alpha: 0.4,
        cap: "round",
        join: "round",
      });
    }

    const head = body[0];
    const rotation = snake.angle - Math.PI / 2; // 贴图舌头朝下，旋转到前进方向
    if (nodes.head) {
      nodes.head.position.set(head.x, head.y);
      nodes.head.rotation = rotation;
      const faceDiameter = nodes.head.texture.width * nodes.skin.headGeometry.diameterRatio;
      nodes.head.scale.set((radius * 2) / faceDiameter);
    }
    if (nodes.headFallback) {
      nodes.headFallback.position.set(head.x, head.y);
      nodes.headFallback.rotation = rotation;
      nodes.headFallback.scale.set(radius / 10);
    }

    nodes.label.visible = showNicknames;
    if (showNicknames) {
      nodes.label.text = snake.nickname;
      nodes.label.position.set(head.x, head.y - radius * 2.1);
    }

    // 无敌期闪烁
    nodes.root.alpha = snake.invulnerable ? 0.55 + Math.sin(nowMs * 0.02) * 0.2 : 1;
  }
}
