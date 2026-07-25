import { Container, Graphics, Text } from "pixi.js";
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

interface SnakeNodes {
  root: Container;
  gfx: Graphics;
  label: Text;
  skin: SkinDefinition;
  /** 舌头吐信动画相位（由 id 稳定推导）。 */
  phase: number;
  lastBody: ReadonlyArray<Point>;
}

interface Bead {
  x: number;
  y: number;
  r: number;
  alternate: boolean;
}

/** 线性混合两个 0xRRGGBB 颜色。 */
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

/** 吐信周期：大部分时间缩回，短暂弹出（0..1 为伸出程度）。 */
function tongueOut(nowMs: number, phase: number, boosting: boolean): number {
  if (boosting) return 1;
  const cycle = (((nowMs * 0.001 + phase) % 3.2) + 3.2) % 3.2;
  if (cycle > 0.55) return 0;
  return Math.sin((cycle / 0.55) * Math.PI);
}

/**
 * 蛇渲染层：贪吃蛇大战风格的程序化绘制。
 * 身体沿脊椎重采样为一串交叠圆珠（节节分明、向尾部收细），
 * 头部为大眼卡通脸 + 周期性吐信；无任何贴图。
 */
export class SnakeLayer {
  readonly container = new Container();
  private snakes = new Map<string, SnakeNodes>();
  private readonly beads: Array<Bead> = [];

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
    const gfx = new Graphics();
    root.addChild(gfx);

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

    let hash = 0;
    for (let index = 0; index < id.length; index += 1) {
      hash = (hash * 31 + id.charCodeAt(index)) | 0;
    }

    this.container.addChild(root);
    nodes = {
      root,
      gfx,
      label,
      skin,
      phase: (Math.abs(hash) % 1000) * 0.0032,
      lastBody: [],
    };
    this.snakes.set(id, nodes);
    return nodes;
  }

  /** 沿脊椎按弧长重采样出圆珠位置（头→尾），只收集视野附近的珠子。 */
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

    const spacing = Math.max(3.5, radius * 0.52);
    const margin = radius * 3;
    let target = 0;
    let travelled = 0;
    let beadIndex = 0;
    let startX = body[0].x;
    let startY = body[0].y;
    for (let index = 1; index < body.length; index += 1) {
      const endX = body[index].x;
      const endY = body[index].y;
      const segmentLength = Math.hypot(endX - startX, endY - startY);
      while (segmentLength > 0 && target <= travelled + segmentLength) {
        const t = (target - travelled) / segmentLength;
        const x = startX + (endX - startX) * t;
        const y = startY + (endY - startY) * t;
        if (
          x > view.left - margin &&
          x < view.right + margin &&
          y > view.top - margin &&
          y < view.bottom + margin
        ) {
          const progress = Math.min(1, target / totalLength);
          const taper = 0.34 + 0.66 * Math.pow(1 - progress, 1.15);
          beads.push({ x, y, r: radius * taper, alternate: beadIndex % 2 === 1 });
        }
        beadIndex += 1;
        target += spacing;
      }
      travelled += segmentLength;
      startX = endX;
      startY = endY;
    }
    return beads;
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
    const gfx = nodes.gfx;
    gfx.clear();

    const beads = this.collectBeads(body, radius, view);
    const alternateColor = mixColor(skin.body, skin.dark, 0.16);

    // 加速光晕先整体垫底，避免盖住相邻圆珠
    if (snake.boosting) {
      for (const bead of beads) {
        gfx.circle(bead.x, bead.y, bead.r * 1.5).fill({ color: skin.light, alpha: 0.13 });
      }
    }

    // 尾→头绘制圆珠：描边 + 主体（深浅相间）+ 背部高光，形成鳞片交叠感
    for (let index = beads.length - 1; index >= 0; index -= 1) {
      const bead = beads[index];
      gfx.circle(bead.x, bead.y, bead.r + 2.3).fill(skin.dark);
    }
    for (let index = beads.length - 1; index >= 0; index -= 1) {
      const bead = beads[index];
      gfx
        .circle(bead.x, bead.y, bead.r)
        .fill(bead.alternate ? alternateColor : skin.body);
      gfx.circle(bead.x, bead.y, bead.r * 0.5).fill({ color: skin.light, alpha: 0.4 });
    }

    this.drawHead(nodes, snake, nowMs);

    nodes.label.visible = showNicknames;
    if (showNicknames) {
      const head = body[0];
      nodes.label.text = snake.nickname;
      nodes.label.position.set(head.x, head.y - radius * 2.3);
    }

    // 无敌期闪烁
    nodes.root.alpha = snake.invulnerable ? 0.55 + Math.sin(nowMs * 0.02) * 0.2 : 1;
  }

  /** 大眼卡通头：脸部朝向移动方向，周期性吐信，加速时一直吐着。 */
  private drawHead(nodes: SnakeNodes, snake: SnakeRenderView, nowMs: number): void {
    const gfx = nodes.gfx;
    const skin = nodes.skin;
    const head = snake.body[0];
    const angle = snake.angle;
    const forwardX = Math.cos(angle);
    const forwardY = Math.sin(angle);
    const perpX = -forwardY;
    const perpY = forwardX;
    const headR = snake.radius * 1.16;
    const hx = head.x + forwardX * snake.radius * 0.25;
    const hy = head.y + forwardY * snake.radius * 0.25;

    if (snake.boosting) {
      gfx.circle(hx, hy, headR * 1.6).fill({ color: skin.light, alpha: 0.15 });
    }
    gfx.circle(hx, hy, headR + 2.5).fill(skin.dark);
    gfx.circle(hx, hy, headR).fill(skin.body);
    // 吻部受光
    gfx
      .circle(hx + forwardX * headR * 0.4, hy + forwardY * headR * 0.4, headR * 0.72)
      .fill({ color: mixColor(skin.body, skin.light, 0.55), alpha: 0.5 });

    // 吐信：基部在吻端，中段前伸后分叉
    const flick = tongueOut(nowMs, nodes.phase, snake.boosting);
    if (flick > 0.01) {
      const baseX = hx + forwardX * headR * 0.92;
      const baseY = hy + forwardY * headR * 0.92;
      const midX = baseX + forwardX * headR * 0.85 * flick;
      const midY = baseY + forwardY * headR * 0.85 * flick;
      const forkLength = headR * 0.5 * flick;
      const spread = 0.4;
      const leftX = midX + Math.cos(angle - spread) * forkLength;
      const leftY = midY + Math.sin(angle - spread) * forkLength;
      const rightX = midX + Math.cos(angle + spread) * forkLength;
      const rightY = midY + Math.sin(angle + spread) * forkLength;
      const tongue = { width: Math.max(1.8, headR * 0.14), color: 0xff5d73, cap: "round" as const };
      gfx.poly([baseX, baseY, midX, midY, leftX, leftY], false).stroke(tongue);
      gfx.poly([midX, midY, rightX, rightY], false).stroke(tongue);
    }

    // 微笑
    const smileX = hx + forwardX * headR * 0.36;
    const smileY = hy + forwardY * headR * 0.36;
    gfx
      .arc(smileX, smileY, headR * 0.3, angle - 1.05, angle + 1.05)
      .stroke({ width: Math.max(1.6, headR * 0.1), color: skin.dark, cap: "round" });

    // 大眼睛：白底 + 前视瞳孔 + 高光点
    const eyeForward = headR * 0.42;
    const eyeSide = headR * 0.6;
    const eyeR = headR * 0.42;
    for (const side of [-1, 1]) {
      const eyeX = hx + forwardX * eyeForward + perpX * side * eyeSide;
      const eyeY = hy + forwardY * eyeForward + perpY * side * eyeSide;
      gfx.circle(eyeX, eyeY, eyeR + 1.6).fill(skin.dark);
      gfx.circle(eyeX, eyeY, eyeR).fill(0xffffff);
      const pupilX = eyeX + forwardX * eyeR * 0.3;
      const pupilY = eyeY + forwardY * eyeR * 0.3;
      gfx.circle(pupilX, pupilY, eyeR * 0.48).fill(0x101528);
      gfx
        .circle(pupilX - eyeR * 0.16, pupilY - eyeR * 0.18, eyeR * 0.16)
        .fill(0xffffff);
    }
  }
}
