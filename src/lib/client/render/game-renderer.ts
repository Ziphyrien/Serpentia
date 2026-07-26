import { Application, Container } from "pixi.js";
import type { FoodState } from "$lib/protocol";
import type { GameController } from "../game.svelte";
import type { SettingsStore } from "../stores/settings.svelte";
import { RENDER, ARENA_COLORS, FOOD_FX_COLORS } from "../config";
import { loadGameTextures } from "./assets";
import { Camera } from "./camera";
import { ArenaLayer } from "./arena-layer";
import { FoodLayer } from "./food-layer";
import { SnakeLayer, type SnakeRenderView } from "./snake-layer";
import { FxLayer } from "./fx-layer";
import { FoodSpeculation } from "../sim/food-speculation";

/**
 * 渲染编排器：拥有 Pixi Application 与所有图层，
 * 每帧从控制器/模拟层拉取最新状态并驱动图层。
 * 是渲染侧唯一的组合点。
 */
export class GameRenderer {
  private app: Application | undefined;
  private world = new Container();
  private camera = new Camera();
  private arena: ArenaLayer | undefined;
  private food: FoodLayer | undefined;
  private snakes: SnakeLayer | undefined;
  private fx: FxLayer | undefined;
  private readonly foodSpeculation = new FoodSpeculation();
  private started = false;
  private destroyed = false;
  private selfRadiusSmooth = 11;
  private lastSelfAlive = false;
  private readonly handleResize = (): void => this.resize();
  private readonly unsubscribeSettings: () => void;

  constructor(
    private readonly controller: GameController,
    private readonly settings: SettingsStore,
  ) {
    this.unsubscribeSettings = settings.subscribe(() => this.applyRenderSettings());
  }

  async init(host: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({
      preference: "webgl",
      antialias: true,
      resizeTo: host,
      background: ARENA_COLORS.surround,
      resolution: this.renderResolution(),
      autoDensity: true,
    });
    if (this.destroyed) {
      app.destroy();
      return;
    }
    this.app = app;
    // resizeTo 只负责画布尺寸，场外底色仍需同步屏幕尺寸
    app.renderer.on("resize", this.handleResize);
    host.appendChild(app.canvas);

    const textures = await loadGameTextures();
    if (this.destroyed) return;

    const rules = this.controller.descriptor.rules;
    this.arena = new ArenaLayer(rules.arenaHalfSize);
    this.food = new FoodLayer(rules.foodRadius, textures.foods, textures.remainsFood);
    this.snakes = new SnakeLayer(textures.snakeSkins);
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
    const alreadyPresented = this.foodSpeculation.confirm(foodId);
    const position = this.food?.positionOf(foodId);
    if (position && !alreadyPresented) this.playFoodFeedback(position, this.selfHead());
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
    this.unsubscribeSettings();
    this.app?.renderer.off("resize", this.handleResize);
    this.foodSpeculation.reset();
    this.snakes?.destroy();
    this.food?.destroy();
    this.fx?.destroy();
    this.app?.destroy(true);
    this.app = undefined;
  }

  private renderResolution(): number {
    return this.settings.highQuality
      ? Math.min(RENDER.maxDevicePixelRatio, window.devicePixelRatio || 1)
      : 1;
  }

  private applyRenderSettings(): void {
    const app = this.app;
    if (!app) return;
    const resolution = this.renderResolution();
    if (app.renderer.resolution === resolution) return;
    app.renderer.resize(app.screen.width, app.screen.height, resolution);
  }

  private frame(deltaMS: number): void {
    if (!this.app || !this.arena || !this.food || !this.snakes || !this.fx) return;
    const controller = this.controller;
    const clock = controller.clockSync;
    const serverNow = clock.serverNow() ?? Date.now();
    const localNow = performance.now();

    // 1. 推进自我预测
    // 转向意图只经 scheduleInput 进入模拟，保证蛇头朝向与躯干实际路径一致
    controller.selfPredictor.advance(localNow);

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
    const selfAlive = Boolean(selfState && selfSnapshot?.alive);
    if (selfAlive && !this.lastSelfAlive && selfSnapshot) {
      this.camera.reset();
      this.selfRadiusSmooth = selfSnapshot.radius;
    }
    this.lastSelfAlive = selfAlive;

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

    // 4. 图层同步
    const viewBounds = this.camera.viewBounds(width, height);
    const nowMs = performance.now();
    const latestSnapshot = controller.latestSnapshot;
    if (latestSnapshot) {
      const hiddenFoods = this.foodSpeculation.update({
        foods: latestSnapshot.foods,
        authoritativeTick: latestSnapshot.tick,
        predictedTick: selfState?.collisionTick ?? latestSnapshot.tick,
        head: selfHead,
        predictedHeadAtTick: (tick) =>
          tick === selfState?.collisionTick
            ? selfState.collisionHead
            : controller.selfPredictor.headAtTick(tick),
        snakeRadius: selfSnapshot?.radius ?? 0,
        foodRadius: controller.descriptor.rules.foodRadius,
        alive: selfAlive,
      });
      for (const foodId of this.foodSpeculation.takeNewlyHiddenFoodIds()) {
        const consumed = latestSnapshot.foods.find((food) => food.id === foodId);
        if (consumed) {
          this.playFoodFeedback(
            { x: consumed.position.x, y: consumed.position.y, kind: consumed.kind },
            selfHead,
          );
        }
      }
      this.food.sync(latestSnapshot.foods, viewBounds, hiddenFoods);
    } else {
      this.foodSpeculation.reset();
    }
    this.snakes.update(views, viewBounds, this.settings.showNicknames, nowMs);
    this.fx.update(deltaMS);
  }

  private playFoodFeedback(
    position: { readonly x: number; readonly y: number; readonly kind: FoodState["kind"] },
    selfHead: { readonly x: number; readonly y: number } | undefined,
  ): void {
    const distance = selfHead
      ? Math.hypot(position.x - selfHead.x, position.y - selfHead.y)
      : Infinity;
    if (distance >= 720) return;
    const color = FOOD_FX_COLORS[position.kind];
    this.fx?.burst(position.x, position.y, color, position.kind === "ambient" ? 8 : 14, 200, 3.5);
    // 普通食物不发声：吃豆是持续行为，逐颗发声会连成一片噪音。
    if (position.kind === "remains" && distance < 400) this.controller.sfx.eatRemains();
  }

  private selfHead(): { x: number; y: number } | undefined {
    const snapshot = this.controller.latestSnapshot?.snakes.find(
      (snake) => snake.id === this.controller.selfId,
    );
    return snapshot?.alive && snapshot.body.length > 0 ? snapshot.body[0] : undefined;
  }
}
