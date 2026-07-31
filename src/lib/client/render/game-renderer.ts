import { Application, Container, UPDATE_PRIORITY } from "pixi.js";
import type { FoodConsumedEvent, FoodState, MagnetConsumedEvent } from "$lib/protocol";
import type { GameController } from "../game.svelte";
import type { SettingsStore } from "../stores/settings.svelte";
import {
  RemoteSnakePresentation,
  type PresentedRemoteSnake,
} from "../sim/remote-snake-presentation";
import { RENDER, ARENA_COLORS } from "../config";
import { MAP_BORDER } from "$lib/game/arena";
import { MAGNET, magnetPositionAfterSourceFrames } from "$lib/game/magnet";
import { foodRadiusOf, usesEatWreckAudio } from "$lib/game/food-metrics";
import { predictFoodPresentationPosition } from "$lib/game/star-food-motion";
import { SNAKE_MOTION, snakeBodyRadius } from "$lib/game/snake-motion";
import { loadGameTextures } from "./assets";
import { Camera } from "./camera";
import { ArenaLayer } from "./arena-layer";
import { FoodLayer } from "./food-layer";
import { MovingFoodPresentation } from "./moving-food-presentation";
import { MagnetToolLayer } from "./magnet-tool-layer";
import { SnakeLayer, type SnakeRenderView } from "./snake-layer";
import { FxLayer } from "./fx-layer";

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
  private magnetTools: MagnetToolLayer | undefined;
  private snakes: SnakeLayer | undefined;
  private fx: FxLayer | undefined;
  private readonly movingFoodPresentation = new MovingFoodPresentation();
  private readonly remoteSnakePresentation: RemoteSnakePresentation;
  private readonly pendingConsumedFoods: Array<FoodConsumedEvent> = [];
  private readonly pendingConsumedMagnets: Array<MagnetConsumedEvent> = [];
  private started = false;
  private destroyed = false;
  private lastSelfAlive = false;
  private authoritativeFramePrepared = false;
  private firstFramePresented = false;
  private readonly handleResize = (): void => this.resize();

  constructor(
    private readonly controller: GameController,
    private readonly settings: SettingsStore,
    private readonly onFirstFramePresented: () => void,
  ) {
    this.remoteSnakePresentation = new RemoteSnakePresentation(
      controller.descriptor.rules,
      controller.descriptor.tickRate,
    );
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
    // 画布在包含权威快照的首帧提交前保持隐藏，避免暴露场外清屏色。
    app.canvas.style.visibility = "hidden";
    // resizeTo 只负责画布尺寸，场外底色仍需同步屏幕尺寸
    app.renderer.on("resize", this.handleResize);
    host.appendChild(app.canvas);

    const textures = await loadGameTextures();
    if (this.destroyed) return;

    const rules = this.controller.descriptor.rules;
    this.arena = new ArenaLayer(rules.arenaHalfSize);
    this.food = new FoodLayer(
      rules,
      {
        dots: textures.foods,
        star: textures.starFood,
        candy: textures.candy,
      },
      rules.arenaHalfSize - MAP_BORDER,
    );
    this.magnetTools = new MagnetToolLayer(textures.magnetTool, rules.arenaHalfSize);
    this.snakes = new SnakeLayer(
      textures.skinFrames,
      textures.speedUp,
      textures.protect,
      textures.magnetEffect,
    );
    this.fx = new FxLayer();
    for (const event of this.pendingConsumedFoods.splice(0)) this.presentConsumedFood(event);
    for (const event of this.pendingConsumedMagnets.splice(0)) this.presentConsumedMagnet(event);

    app.stage.addChild(this.arena.screenContainer);
    this.world.addChild(this.arena.worldContainer);
    this.world.addChild(this.food.container);
    this.world.addChild(this.magnetTools.container);
    this.world.addChild(this.snakes.container);
    this.world.addChild(this.fx.container);
    app.stage.addChild(this.world);

    this.resize();
  }

  start(): void {
    if (this.started || !this.app) return;
    this.started = true;
    this.app.ticker.add(({ deltaMS }) => this.frame(deltaMS));
    // Application.render 以 LOW 优先级运行；UTILITY 回调发生在实际提交之后。
    this.app.ticker.add(this.afterRender, undefined, UPDATE_PRIORITY.UTILITY);
  }

  /** 权威碰撞确认后登记食物事件；具体帧位由消费者的呈现时间轴决定。 */
  foodConsumed(event: FoodConsumedEvent): void {
    if (this.destroyed) return;
    if (!this.food) {
      this.pendingConsumedFoods.push(event);
      return;
    }
    this.presentConsumedFood(event);
  }

  magnetConsumed(event: MagnetConsumedEvent): void {
    if (this.destroyed) return;
    if (!this.magnetTools) {
      this.pendingConsumedMagnets.push(event);
      return;
    }
    this.presentConsumedMagnet(event);
  }

  /** 蛇死亡：沿身体爆裂（由控制器在事件到达时调用）。 */
  snakeDied(playerId: string): void {
    const last = this.snakes?.lastBodyOf(playerId);
    if (!last || last.body.length === 0) return;
    const samples = Math.min(14, last.body.length);
    const stride = Math.max(1, Math.floor(last.body.length / samples));
    for (let index = 0; index < last.body.length; index += stride) {
      const point = last.body[index];
      this.fx?.burst(point.x, point.y, last.bodyColor, 5, 180, 4);
    }
  }

  resize(): void {
    if (!this.app) return;
    this.arena?.resize(this.app.screen.width, this.app.screen.height);
  }

  destroy(): void {
    this.destroyed = true;
    this.app?.ticker.remove(this.afterRender);
    this.app?.renderer.off("resize", this.handleResize);
    this.pendingConsumedFoods.length = 0;
    this.pendingConsumedMagnets.length = 0;
    this.movingFoodPresentation.reset();
    this.remoteSnakePresentation.reset();
    this.snakes?.destroy();
    this.food?.destroy();
    this.magnetTools?.destroy();
    this.fx?.destroy();
    this.app?.destroy(true);
    this.app = undefined;
  }

  /** 对齐原版 `cc.view.enableRetina(true)`：启动时始终启用高 DPI 后备缓冲。 */
  private renderResolution(): number {
    return Math.min(RENDER.maxDevicePixelRatio, window.devicePixelRatio || 1);
  }

  private frame(deltaMS: number): void {
    if (!this.app || !this.arena || !this.food || !this.magnetTools || !this.snakes || !this.fx) {
      return;
    }
    const controller = this.controller;
    const rules = controller.descriptor.rules;
    const clock = controller.clockSync;
    const serverNow = clock.serverNow() ?? Date.now();
    const localNow = performance.now();

    // 1. 推进自我预测
    // 转向意图只经 scheduleInput 进入模拟，保证蛇头朝向与躯干实际路径一致
    controller.selfPredictor.advance(localNow);

    // 2. 组装本帧蛇视图
    const latestSnapshot = controller.latestSnapshot;
    const selfSnapshot = latestSnapshot?.snakes.find((snake) => snake.id === controller.selfId);
    const selfState = controller.selfPredictor.renderState();
    const selfAlive = Boolean(selfState && selfSnapshot?.alive);
    if (selfAlive && !this.lastSelfAlive) this.camera.reset();
    this.lastSelfAlive = selfAlive;

    const views: Array<SnakeRenderView> = [];
    const renderTime = serverNow - controller.snapshotBuffer.interpolationDelay();
    const sourceFramesPerTick = Math.max(
      1,
      Math.round(SNAKE_MOTION.sourceFrameRate / controller.descriptor.tickRate),
    );
    let remotePresentationSourceFrame: number | undefined;
    let remoteSnakes: ReadonlyArray<PresentedRemoteSnake>;
    if (selfState && selfSnapshot?.alive && latestSnapshot !== undefined) {
      remotePresentationSourceFrame = selfState.presentationSourceFrame;
      remoteSnakes = this.remoteSnakePresentation.sample(
        latestSnapshot.snakes,
        latestSnapshot.tick,
        selfState.presentationSourceFrame,
        deltaMS,
        controller.selfId,
      );
    } else {
      this.remoteSnakePresentation.reset();
      const remotePresentationTick = controller.snapshotBuffer.presentationTick(renderTime);
      remotePresentationSourceFrame =
        remotePresentationTick === undefined
          ? undefined
          : remotePresentationTick * sourceFramesPerTick;
      remoteSnakes = controller.snapshotBuffer.sampleRemoteSnakes(renderTime);
    }
    for (const remote of remoteSnakes) {
      views.push({
        id: remote.id,
        nickname: remote.nickname,
        skinId: remote.skinId,
        body: remote.body,
        angle: remote.angle,
        bodyScale: remote.bodyScale,
        boosting: remote.boosting && remote.length > rules.minimumLength,
        invulnerable: remote.invulnerable,
        magnetActive:
          remotePresentationSourceFrame !== undefined &&
          remote.magnetUntilSourceFrame !== null &&
          remotePresentationSourceFrame < remote.magnetUntilSourceFrame,
        isSelf: false,
      });
    }

    let selfHead: { x: number; y: number } | undefined;
    let selfView: SnakeRenderView | undefined;
    if (selfState && selfSnapshot?.alive) {
      selfView = {
        id: selfSnapshot.id,
        nickname: selfSnapshot.nickname,
        skinId: selfSnapshot.skinId,
        body: selfState.body,
        angle: selfState.angle,
        bodyScale: selfState.bodyScale,
        boosting:
          selfState.boosting && controller.selfPredictor.currentLength > rules.minimumLength,
        invulnerable: selfSnapshot.invulnerable,
        magnetActive:
          selfSnapshot.magnetUntilSourceFrame != null &&
          selfState.presentationSourceFrame < selfSnapshot.magnetUntilSourceFrame,
        isSelf: true,
      };
      views.push(selfView);
      selfHead = selfState.body[0];
    }

    // 3. 相机
    if (selfHead && selfSnapshot?.alive) {
      this.camera.update(selfHead.x, selfHead.y, controller.selfPredictor.currentLength);
    }
    const { width, height } = this.app.screen;
    // 原版 Canvas 固定高度：纵向始终是 750 设计单位，宽屏只增加左右视野。
    const worldScale = this.camera.worldScale(width, height);
    this.world.scale.set(worldScale);
    this.world.position.set(
      width / 2 - this.camera.x * worldScale,
      height / 2 - this.camera.y * worldScale,
    );

    // 4. 图层同步
    const viewBounds = this.camera.viewBounds(width, height);
    const nowMs = performance.now();
    if (latestSnapshot) {
      const authoritativeSourceFrame = latestSnapshot.tick * sourceFramesPerTick;
      const presentedFoods =
        selfState && selfSnapshot?.alive
          ? latestSnapshot.foods.map((food) => {
              const position = predictFoodPresentationPosition(
                food,
                authoritativeSourceFrame,
                selfState.presentationSourceFrame,
                rules.arenaHalfSize - MAP_BORDER,
                foodRadiusOf(food, rules),
              );
              return position === undefined ? food : { ...food, position };
            })
          : controller.snapshotBuffer.sampleFoods(renderTime);
      const smoothedFoods =
        selfState && selfSnapshot?.alive
          ? this.movingFoodPresentation.sample(presentedFoods, deltaMS)
          : presentedFoods;
      if (!selfState || !selfSnapshot?.alive) this.movingFoodPresentation.reset();
      this.food.sync(smoothedFoods, viewBounds, authoritativeSourceFrame, latestSnapshot.foods);
      const presentedMagnets =
        selfState && selfSnapshot?.alive
          ? (latestSnapshot.magnets ?? []).map((magnet) => {
              const elapsed = Math.max(
                0,
                Math.min(
                  magnet.linearFramesRemaining,
                  selfState.presentationSourceFrame - authoritativeSourceFrame,
                ),
              );
              return {
                ...magnet,
                position: magnetPositionAfterSourceFrames(magnet, elapsed, rules.arenaHalfSize),
              };
            })
          : controller.snapshotBuffer.sampleMagnets(renderTime);
      this.magnetTools.sync(
        presentedMagnets,
        viewBounds,
        authoritativeSourceFrame,
        latestSnapshot.magnets ?? [],
      );
    }
    if (selfHead && selfState && selfSnapshot?.alive) {
      const predictedMagnets = this.magnetTools.predictSelfContacts(
        selfSnapshot.id,
        selfHead,
        selfState.collisionHead,
        snakeBodyRadius(selfState.bodyScale),
        rules.eatDistanceFactor,
        selfState.presentationSourceFrame,
        selfState.collisionSourceFrame,
      );
      if (predictedMagnets.length > 0) controller.sfx.eatTool();
      if (selfView && this.magnetTools.hasPredictedPickup(selfSnapshot.id)) {
        selfView.magnetActive = true;
      }

      const predictedFoods = this.food.predictSelfContacts(
        selfSnapshot.id,
        selfHead,
        selfState.collisionHead,
        snakeBodyRadius(selfState.bodyScale),
        rules.eatDistanceFactor,
        selfSnapshot.magnetUntilSourceFrame != null &&
          selfState.collisionSourceFrame < selfSnapshot.magnetUntilSourceFrame
          ? MAGNET.extraEatScope
          : 0,
        selfState.presentationSourceFrame,
        selfState.collisionSourceFrame,
      );
      for (const food of predictedFoods) this.playFoodAudio(food);
    }
    const presentationHeads = new Map<string, { readonly x: number; readonly y: number }>();
    for (const view of views) {
      const head = view.body[0];
      if (head !== undefined) presentationHeads.set(view.id, head);
    }
    const presentationSourceFrame = (playerId: string): number | undefined =>
      playerId === controller.selfId
        ? (selfState?.presentationSourceFrame ?? remotePresentationSourceFrame)
        : remotePresentationSourceFrame;
    const presentationHead = (
      playerId: string,
    ): { readonly x: number; readonly y: number } | undefined => presentationHeads.get(playerId);
    const presentedFoods = this.food.update(viewBounds, presentationSourceFrame, presentationHead);
    for (const event of presentedFoods) {
      if (event.playerId === controller.selfId) this.playFoodAudio(event.food);
    }
    const presentedMagnets = this.magnetTools.update(
      viewBounds,
      presentationSourceFrame,
      presentationHead,
    );
    for (const event of presentedMagnets) {
      if (event.playerId === controller.selfId) controller.sfx.eatTool();
    }
    this.snakes.update(views, viewBounds, this.settings.showNicknames, nowMs);
    this.fx.update(deltaMS);
    if (controller.status === "online" && latestSnapshot !== undefined) {
      this.authoritativeFramePrepared = true;
    }
  }

  /** Pixi 自动渲染完成后，只报告一次包含权威快照的首帧。 */
  private readonly afterRender = (): void => {
    if (this.firstFramePresented || !this.authoritativeFramePrepared) return;
    this.firstFramePresented = true;
    this.app?.ticker.remove(this.afterRender);
    this.app?.canvas.style.removeProperty("visibility");
    this.onFirstFramePresented();
  };

  private presentConsumedFood(event: FoodConsumedEvent): void {
    this.food?.startAbsorb(event);
  }

  private presentConsumedMagnet(event: MagnetConsumedEvent): void {
    this.magnetTools?.consume(event);
  }

  private playFoodAudio(food: FoodState): void {
    if (usesEatWreckAudio(food, this.controller.descriptor.rules)) {
      this.controller.sfx.eatRemains();
    }
  }
}
