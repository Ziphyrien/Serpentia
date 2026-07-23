import { Application, Container } from "pixi.js";
import type { GameController } from "../game.svelte";
import type { SettingsStore } from "../stores/settings.svelte";
import { RENDER, skinForPlayer } from "../config";
import { loadGameTextures, type GameTextures } from "./assets";
import { Camera } from "./camera";
import { ArenaLayer } from "./arena-layer";
import { FoodLayer } from "./food-layer";
import { SnakeLayer, type SnakeRenderView } from "./snake-layer";
import { FxLayer } from "./fx-layer";

/**
 * 渲染编排器：拥有 Pixi Application 与所有图层，
 * 每帧从控制器/模拟层拉取最新状态并驱动图层。
 * 是渲染侧唯一的组合点。
 */
export class GameRenderer {
  private app: Application | undefined;
  private textures: GameTextures | undefined;
  private world = new Container();
  private camera = new Camera();
  private arena: ArenaLayer | undefined;
  private food: FoodLayer | undefined;
  private snakes: SnakeLayer | undefined;
  private fx: FxLayer | undefined;
  private started = false;
  private destroyed = false;
  private trailAccumulator = 0;
  private selfRadiusSmooth = 11;
  private lastBoosting = false;
  private readonly handleResize = (): void => this.resize();

  constructor(
    private readonly controller: GameController,
    private readonly settings: SettingsStore,
  ) {}

  async init(host: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({
      preference: "webgl",
      antialias: true,
      resizeTo: host,
      background: 0x0b1020,
      resolution: this.settings.highQuality
        ? Math.min(RENDER.maxDevicePixelRatio, window.devicePixelRatio || 1)
        : 1,
      autoDensity: true,
    });
    if (this.destroyed) {
      app.destroy();
      return;
    }
    this.app = app;
    // resizeTo 只负责画布尺寸，星空背景要跟着屏幕旋转/缩放联动
    app.renderer.on("resize", this.handleResize);
    host.appendChild(app.canvas);

    this.textures = await loadGameTextures();
    if (this.destroyed) return;

    const rules = this.controller.descriptor.rules;
    this.arena = new ArenaLayer(this.textures.bgTile, rules.arenaHalfSize);
    this.food = new FoodLayer(this.textures.foodPearl, this.textures.foodGold, rules.foodRadius);
    this.snakes = new SnakeLayer(this.textures);
    this.fx = new FxLayer();

    app.stage.addChild(this.arena.screenContainer);
    this.world.addChild(this.arena.worldContainer);
    this.world.addChild(this.food.container);
    this.world.addChild(this.snakes.container);
    this.world.addChild(this.fx.container);
    app.stage.addChild(this.world);

    this.resize();
  }

  start(): void {
    if (this.started || !this.app) return;
    this.started = true;
    this.app.ticker.add(({ deltaMS }) => this.frame(deltaMS));
  }

  /** 食物被吃：闪光 + 就近音效（由控制器在事件到达时调用）。 */
  foodConsumed(foodId: number): void {
    const position = this.food?.positionOf(foodId);
    if (!position) return;
    const selfHead = this.selfHead();
    const distance = selfHead
      ? Math.hypot(position.x - selfHead.x, position.y - selfHead.y)
      : Infinity;
    if (distance < 720) {
      const color = position.kind === "boost" ? 0xffd75e : 0xfff3f8;
      this.fx?.burst(position.x, position.y, color, position.kind === "ambient" ? 8 : 14, 200, 3.5);
      if (distance < 400) this.controller.sfx.eat(position.kind !== "ambient");
    }
    this.food?.remove(foodId);
  }

  /** 蛇死亡：沿身体爆裂（由控制器在事件到达时调用）。 */
  snakeDied(playerId: string): void {
    const last = this.snakes?.lastBodyOf(playerId);
    if (!last || last.body.length === 0) return;
    const samples = Math.min(14, last.body.length);
    const stride = Math.max(1, Math.floor(last.body.length / samples));
    for (let index = 0; index < last.body.length; index += stride) {
      const point = last.body[index];
      this.fx?.burst(point.x, point.y, last.skin.body, 5, 180, 4);
    }
  }

  resize(): void {
    if (!this.app) return;
    this.arena?.resize(this.app.screen.width, this.app.screen.height);
  }

  destroy(): void {
    this.destroyed = true;
    this.app?.renderer.off("resize", this.handleResize);
    this.snakes?.destroy();
    this.food?.destroy();
    this.fx?.destroy();
    this.app?.destroy(true);
    this.app = undefined;
  }

  private frame(deltaMS: number): void {
    if (!this.app || !this.arena || !this.food || !this.snakes || !this.fx) return;
    const controller = this.controller;
    const clock = controller.clockSync;
    const serverNow = clock.serverNow() ?? Date.now();
    const localNow = performance.now();

    // 1. 推进自我预测
    // 无方向输入时传 undefined，避免把出生朝向往 angle=0（正东）拽
    controller.selfPredictor.advance(
      localNow,
      controller.input.hasDirection ? controller.input.angle : undefined,
      controller.input.boosting,
    );

    // 2. 组装本帧蛇视图
    // 加速意图不等于加速生效：长度低于阈值时速度不变，不该显示加速光晕
    const minBoostLength = controller.descriptor.rules.boostMinimumLength;
    const views: Array<SnakeRenderView> = [];
    const renderTime = serverNow - controller.snapshotBuffer.interpolationDelay();
    for (const remote of controller.snapshotBuffer.sampleRemoteSnakes(renderTime)) {
      views.push({
        id: remote.id,
        nickname: remote.nickname,
        body: remote.body,
        angle: remote.angle,
        radius: remote.radius,
        boosting: remote.boosting && remote.length > minBoostLength,
        invulnerable: remote.invulnerable,
        isSelf: false,
      });
    }

    const selfSnapshot = controller.latestSnapshot?.snakes.find(
      (snake) => snake.id === controller.selfId,
    );
    const selfState = controller.selfPredictor.renderState();
    let selfHead: { x: number; y: number } | undefined;
    let selfBoosting = false;
    if (selfState && selfSnapshot?.alive) {
      const radius = selfSnapshot.radius;
      this.selfRadiusSmooth += (radius - this.selfRadiusSmooth) * 0.08;
      selfBoosting = selfState.boosting && controller.selfPredictor.currentLength > minBoostLength;
      views.push({
        id: selfSnapshot.id,
        nickname: selfSnapshot.nickname,
        body: selfState.body,
        angle: selfState.angle,
        radius: this.selfRadiusSmooth,
        boosting: selfBoosting,
        invulnerable: selfSnapshot.invulnerable,
        isSelf: true,
      });
      selfHead = selfState.body[0];

      // 加速拖尾
      if (selfBoosting) {
        this.trailAccumulator += deltaMS;
        const tail = selfState.body[selfState.body.length - 1];
        while (this.trailAccumulator > 40 && tail) {
          this.trailAccumulator -= 40;
          this.fx.trail(tail.x, tail.y, skinForPlayer(selfSnapshot.id).light);
        }
      }
    }

    // 3. 相机
    if (selfHead && selfSnapshot?.alive) {
      this.camera.update(selfHead.x, selfHead.y, this.selfRadiusSmooth, deltaMS);
    }
    const { width, height } = this.app.screen;
    this.world.scale.set(this.camera.zoom);
    this.world.position.set(
      width / 2 - this.camera.x * this.camera.zoom,
      height / 2 - this.camera.y * this.camera.zoom,
    );
    this.arena.update(this.camera);

    // 4. 图层同步
    const viewBounds = this.camera.viewBounds(width, height);
    const nowMs = performance.now();
    if (controller.latestSnapshot)
      this.food.sync(controller.latestSnapshot.foods, viewBounds, nowMs);
    this.snakes.update(views, viewBounds, this.settings.showNicknames, nowMs);
    this.fx.update(deltaMS);

    // 5. 加速音效状态（同样以生效为准，长度不足时不发声）
    const boosting = Boolean(selfSnapshot?.alive && selfBoosting);
    if (boosting !== this.lastBoosting) {
      this.lastBoosting = boosting;
      controller.sfx.setBoosting(boosting);
    }

    // 6. 边界接近提示
    if (selfHead && selfSnapshot?.alive) {
      const limit = controller.descriptor.rules.arenaHalfSize;
      const distanceToBorder = limit - Math.max(Math.abs(selfHead.x), Math.abs(selfHead.y));
      controller.nearBoundary = distanceToBorder < 220;
    } else {
      controller.nearBoundary = false;
    }
  }

  private selfHead(): { x: number; y: number } | undefined {
    const snapshot = this.controller.latestSnapshot?.snakes.find(
      (snake) => snake.id === this.controller.selfId,
    );
    return snapshot?.alive && snapshot.body.length > 0 ? snapshot.body[0] : undefined;
  }
}
