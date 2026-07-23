<script lang="ts">
  import { onMount } from "svelte";
  import Zap from "lucide-svelte/icons/zap";
  import type { GameController } from "$lib/client/game.svelte";

  let { controller }: { controller: GameController } = $props();

  let zone = $state<HTMLDivElement>();
  let boosting = $state(false);

  // 长度不够时加速无效：按钮变暗提示，按下也不显示生效样式
  const canBoost = $derived(controller.self.length > controller.descriptor.rules.boostMinimumLength);
  const buttonClass = $derived(
    boosting
      ? canBoost
        ? "scale-95 border-amber-200 bg-amber-400 text-night-950 shadow-[0_0_30px_rgba(251,191,36,0.6)]"
        : "scale-95 border-white/15 bg-white/10 text-white/50"
      : "border-white/25 bg-amber-300/90 text-night-950",
  );

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
  class="absolute right-[max(1.5rem,env(safe-area-inset-right))] bottom-[max(2.5rem,env(safe-area-inset-bottom))] z-10 flex size-24 touch-none items-center justify-center rounded-full border-4 font-black transition select-none landscape-short:size-20 {buttonClass} {canBoost
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
