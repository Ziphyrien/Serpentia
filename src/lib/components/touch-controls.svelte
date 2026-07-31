<script lang="ts">
  import { onMount } from "svelte";
  import Zap from "lucide-svelte/icons/zap";
  import type { GameController } from "$lib/client/game.svelte";
  import { pseudoLandscape } from "$lib/client/pseudo-landscape.svelte";

  let { controller }: { controller: GameController } = $props();

  let zone = $state<HTMLDivElement>();
  let boosting = $state(false);

  // 长度不够时加速无效：按钮变暗提示，按下也不显示生效样式
  const canBoost = $derived(controller.self.length > controller.descriptor.rules.minimumLength);
  const buttonClass = $derived.by(() => {
    if (!boosting) return "border-white/70 bg-map-grid/90 text-map-ink";
    if (!canBoost) return "scale-95 border-white/50 bg-map-grid/70 text-map-ink/50";
    return "scale-95 border-amber-200 bg-amber-400 text-night-950";
  });

  onMount(() => {
    if (zone) controller.joystick.attach(zone);
    return () => {
      controller.joystick.detach();
      controller.input.setBoosting("touch", false);
    };
  });

  function setBoost(active: boolean): void {
    boosting = active;
    controller.input.setBoosting("touch", active);
  }
</script>

<div
  bind:this={zone}
  class="absolute inset-y-0 left-0 z-10 w-3/5"
  class:joystick-zone-pseudo={pseudoLandscape.active}
  data-ui
></div>

<button
  class="touch-boost absolute right-6 bottom-10 z-10 flex touch-none items-center justify-center rounded-full border-4 font-black transition select-none {buttonClass} {canBoost
    ? ''
    : 'opacity-50'}"
  style="text-shadow: none;"
  ontouchstart={(e) => {
    e.preventDefault();
    setBoost(true);
  }}
  ontouchend={() => setBoost(false)}
  ontouchcancel={() => setBoost(false)}
  oncontextmenu={(e) => e.preventDefault()}
  data-ui
>
  <span class="flex flex-col items-center">
    <Zap size={26} strokeWidth={2.5} />
    <span class="text-xs">加速</span>
  </span>
</button>

<style>
  /*
   * 伪横屏下把摇杆区域反向旋转 90°，与画面旋转相互抵消：
   * nipplejs 依赖 getBoundingClientRect 的屏幕坐标计算保持正确，
   * 摇杆仍出现在手指下方（圆形摇杆无方向性，视觉不受影响）。
   * 几何推导：抵消后区域恰好覆盖屏幕上方 60%（即旋转画面的左侧）。
   */
  .joystick-zone-pseudo {
    inset: auto;
    top: calc(50dvw - 30dvh);
    left: calc(30dvh - 50dvw);
    width: 100dvw;
    height: 60dvh;
    transform: rotate(-90deg);
  }

  .touch-boost {
    /* 以画面高度为基准缩放，短横屏（含伪横屏）下自动收紧 */
    width: clamp(5rem, calc(16.67 * var(--game-vh, 1dvh)), 6rem);
    height: clamp(5rem, calc(16.67 * var(--game-vh, 1dvh)), 6rem);
  }

  /* nipplejs 运行时插入摇杆节点，这里补充轮廓与旋钮透明度。 */
  :global(.joystick > .back) {
    box-sizing: border-box;
    border: 2px solid rgb(85 88 106 / 0.28);
  }

  :global(.joystick > .front) {
    box-sizing: border-box;
    border: 1px solid rgb(85 88 106 / 0.2);
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.35);
    opacity: 1 !important;
  }
</style>
