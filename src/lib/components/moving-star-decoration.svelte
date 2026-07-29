<script lang="ts">
  import { onMount } from "svelte";
  import {
    DECORATIVE_STAR_SOURCE_FRAME_RATE,
    advanceDecorativeStarSourceFrame,
    clampDecorativeStarToBounds,
    randomDecorativeStarLinearFrames,
    type DecorativeStarBounds,
    type DecorativeStarState,
  } from "$lib/client/decorative-star-motion";

  let field = $state<HTMLDivElement>();
  let star = $state<HTMLImageElement>();

  onMount(() => {
    const fieldElement = field;
    const starElement = star;
    if (fieldElement === undefined || starElement === undefined) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const randomDirection = (): number => Math.floor(Math.random() * 360);
    const randomLinearFrames = (): number => randomDecorativeStarLinearFrames(Math.random());
    const bounds = (): DecorativeStarBounds => ({
      width: fieldElement.clientWidth,
      height: fieldElement.clientHeight,
      radius: starElement.offsetWidth / 2,
    });

    let state: DecorativeStarState = {
      x: fieldElement.clientWidth * 0.58,
      y: fieldElement.clientHeight * 0.45,
      directionDegrees: randomDirection(),
      linearFramesRemaining: randomLinearFrames(),
    };
    let animationFrame = 0;
    let previousTime = performance.now();
    let accumulatedTime = 0;
    const sourceFrameMilliseconds = 1000 / DECORATIVE_STAR_SOURCE_FRAME_RATE;

    const render = (): void => {
      const currentBounds = bounds();
      starElement.style.transform = `translate3d(${state.x - currentBounds.radius}px, ${state.y - currentBounds.radius}px, 0)`;
      starElement.style.opacity = "1";
    };

    const resize = (): void => {
      state = clampDecorativeStarToBounds(state, bounds());
      render();
    };

    const animate = (time: number): void => {
      const elapsed = Math.min(100, Math.max(0, time - previousTime));
      previousTime = time;
      accumulatedTime += elapsed;
      const currentBounds = bounds();
      while (accumulatedTime >= sourceFrameMilliseconds) {
        state = advanceDecorativeStarSourceFrame(
          state,
          currentBounds,
          randomDirection(),
          randomLinearFrames(),
        );
        accumulatedTime -= sourceFrameMilliseconds;
      }
      render();
      animationFrame = requestAnimationFrame(animate);
    };

    const syncMotionPreference = (): void => {
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      accumulatedTime = 0;
      previousTime = performance.now();
      if (!reducedMotion.matches) animationFrame = requestAnimationFrame(animate);
    };

    resize();
    syncMotionPreference();
    window.addEventListener("resize", resize, { passive: true });
    reducedMotion.addEventListener("change", syncMotionPreference);
    return () => {
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      reducedMotion.removeEventListener("change", syncMotionPreference);
    };
  });
</script>

<div
  bind:this={field}
  class="absolute top-[15%] right-[2%] size-32 overflow-hidden sm:right-[4%] sm:size-40 md:top-[19%] md:right-[6%] md:h-[25%] md:w-[21%]"
>
  <img
    bind:this={star}
    src="/assets/art/food/star.png"
    alt=""
    draggable="false"
    class="absolute top-0 left-0 size-9 opacity-0 will-change-transform select-none sm:size-10 md:size-12"
  />
</div>
