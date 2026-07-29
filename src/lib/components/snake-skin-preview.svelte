<script lang="ts">
  import {
    bodyNodeAt,
    nodeFrameName,
    type InternalSkin,
    type SkinFrame,
  } from "$lib/game/internal-skins";

  let {
    skin,
    width = 300,
    height = 170,
    animated = false,
  }: {
    skin: InternalSkin;
    width?: number;
    height?: number;
    animated?: boolean;
  } = $props();

  let canvas = $state<HTMLCanvasElement>();

  $effect(() => {
    const target = canvas;
    if (!target) return;

    let disposed = false;
    let started = false;
    let startedAt = 0;
    let animationFrame = 0;
    const image = new Image();
    const extractedFrames = new Map<string, HTMLCanvasElement>();

    const render = (time: number): void => {
      if (disposed) return;
      const frameCount = animated ? Math.floor((time - startedAt) / (1000 / 60)) : 0;
      drawSnake(target, image, skin, width, height, frameCount, extractedFrames);
      if (animated) animationFrame = requestAnimationFrame(render);
    };
    const loaded = (): void => {
      if (started) return;
      started = true;
      startedAt = performance.now();
      render(startedAt);
    };

    image.addEventListener("load", loaded);
    image.src = skin.atlas.path;
    if (image.complete && image.naturalWidth > 0) loaded();

    return () => {
      disposed = true;
      image.removeEventListener("load", loaded);
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
    };
  });

  function drawSnake(
    target: HTMLCanvasElement,
    atlas: HTMLImageElement,
    currentSkin: InternalSkin,
    displayWidth: number,
    displayHeight: number,
    frameCount: number,
    extractedFrames: Map<string, HTMLCanvasElement>,
  ): void {
    const resolution = Math.min(2, window.devicePixelRatio || 1);
    const backingWidth = Math.round(displayWidth * resolution);
    const backingHeight = Math.round(displayHeight * resolution);
    if (target.width !== backingWidth || target.height !== backingHeight) {
      target.width = backingWidth;
      target.height = backingHeight;
    }

    const context = target.getContext("2d");
    if (!context) return;
    context.setTransform(resolution, 0, 0, resolution, 0, 0);
    context.clearRect(0, 0, displayWidth, displayHeight);

    const firstBodyName = currentSkin.body[0].textures[0];
    const firstBodyFrame = currentSkin.frames[firstBodyName];
    if (firstBodyFrame === undefined) return;
    const bodyDisplayWidth = Math.min(displayHeight * 0.19, displayWidth * 0.09);
    const scale =
      (bodyDisplayWidth * currentSkin.bodyRenderWidthRate) / firstBodyFrame.width;
    const points = previewPoints(displayWidth, displayHeight, 10);

    const tailIndex = points.length - 1;
    if (currentSkin.tail !== null) {
      const tailName = nodeFrameName(currentSkin.tail, frameCount);
      drawNode(
        context,
        extractFrame(atlas, currentSkin, tailName, extractedFrames),
        points[tailIndex],
        directionAt(points, tailIndex),
        scale,
      );
    }

    const lastBodyIndex = currentSkin.tail === null ? tailIndex : tailIndex - 1;
    for (let index = lastBodyIndex; index >= 1; index -= 1) {
      const node = bodyNodeAt(currentSkin.body, index);
      const frameName = nodeFrameName(node, frameCount);
      drawNode(
        context,
        extractFrame(atlas, currentSkin, frameName, extractedFrames),
        points[index],
        directionAt(points, index),
        scale,
      );
    }

    const headName = nodeFrameName(currentSkin.head, frameCount);
    drawNode(
      context,
      extractFrame(atlas, currentSkin, headName, extractedFrames),
      points[0],
      directionAt(points, 0),
      scale,
    );
  }

  function previewPoints(
    displayWidth: number,
    displayHeight: number,
    count: number,
  ): Array<{ x: number; y: number }> {
    return Array.from({ length: count }, (_, index) => {
      const ratio = index / (count - 1);
      return {
        x: displayWidth * (0.77 - ratio * 0.57),
        y:
          displayHeight *
          (0.5 + Math.sin(ratio * Math.PI * 1.55) * 0.17),
      };
    });
  }

  function directionAt(
    points: ReadonlyArray<{ x: number; y: number }>,
    index: number,
  ): number {
    const current = points[index];
    const behind = points[Math.min(index + 1, points.length - 1)];
    if (current === behind) {
      const ahead = points[Math.max(0, index - 1)];
      return Math.atan2(current.y - ahead.y, current.x - ahead.x) + Math.PI;
    }
    return Math.atan2(current.y - behind.y, current.x - behind.x);
  }

  function drawNode(
    context: CanvasRenderingContext2D,
    frame: HTMLCanvasElement,
    point: { x: number; y: number },
    direction: number,
    scale: number,
  ): void {
    const frameWidth = frame.width * scale;
    const frameHeight = frame.height * scale;
    context.save();
    context.translate(point.x, point.y);
    context.rotate(direction + Math.PI / 2);
    context.drawImage(
      frame,
      -frameWidth / 2,
      -frameHeight / 2,
      frameWidth,
      frameHeight,
    );
    context.restore();
  }

  function extractFrame(
    atlas: HTMLImageElement,
    currentSkin: InternalSkin,
    frameName: string,
    extractedFrames: Map<string, HTMLCanvasElement>,
  ): HTMLCanvasElement {
    const cached = extractedFrames.get(frameName);
    if (cached) return cached;
    const frame = currentSkin.frames[frameName];
    if (frame === undefined) throw new Error(`Skin ${currentSkin.id} has no frame ${frameName}`);

    const extracted = document.createElement("canvas");
    extracted.width = frame.width;
    extracted.height = frame.height;
    const context = extracted.getContext("2d");
    if (!context) return extracted;
    drawExtractedFrame(context, atlas, frame);
    extractedFrames.set(frameName, extracted);
    return extracted;
  }

  function drawExtractedFrame(
    context: CanvasRenderingContext2D,
    atlas: HTMLImageElement,
    frame: SkinFrame,
  ): void {
    if (frame.rotated) {
      context.translate(0, frame.height);
      context.rotate(-Math.PI / 2);
      context.drawImage(
        atlas,
        frame.x,
        frame.y,
        frame.height,
        frame.width,
        0,
        0,
        frame.height,
        frame.width,
      );
      return;
    }
    context.drawImage(
      atlas,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      0,
      0,
      frame.width,
      frame.height,
    );
  }
</script>

<canvas
  bind:this={canvas}
  aria-hidden="true"
  class="block h-auto max-w-full touch-pan-y"
  style:width="{width}px"
></canvas>
