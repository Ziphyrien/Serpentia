<script lang="ts">
  import { onMount } from "svelte";
  import Zap from "lucide-svelte/icons/zap";
  import type { GameController } from "$lib/client/game.svelte";

  let { controller }: { controller: GameController } = $props();

  let zone = $state<HTMLDivElement>();
  let boosting = $state(false);

  onMount(() => {
    if (zone) controller.joystick.attach(zone);
    return () => controller.joystick.detach();
  });

  function setBoost(active: boolean): void {
    boosting = active;
    controller.input.boosting = active;
  }
</script>

<!-- 摇杆区域：左半屏动态落点 -->
<div bind:this={zone} class="absolute inset-y-0 left-0 z-10 w-3/5" data-ui></div>

<!-- 加速按钮：右下大圆钮 -->
<button
  class="absolute right-6 bottom-10 z-10 flex size-24 touch-none items-center justify-center rounded-full border-4 font-black text-night-950 transition select-none {boosting
    ? 'scale-95 border-amber-200 bg-amber-400 shadow-[0_0_30px_rgba(251,191,36,0.6)]'
    : 'border-white/25 bg-amber-300/90'}"
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
