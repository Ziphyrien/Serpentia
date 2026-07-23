<script lang="ts">
  import Skull from "lucide-svelte/icons/skull";
  import Ruler from "lucide-svelte/icons/ruler";
  import Sword from "lucide-svelte/icons/sword";
  import type { HudSelf } from "$lib/client/game.svelte";

  let { self }: { self: HudSelf } = $props();

  const countdown = $derived(Math.max(0, Math.ceil(self.respawnIn)));
</script>

<div class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-night-950/45">
  <div
    class="feed-in flex max-h-[calc(100dvh-2rem)] w-72 flex-col items-center overflow-y-auto rounded-3xl border border-panel-border bg-panel p-6 backdrop-blur-md"
  >
    <span class="mb-2 flex size-14 items-center justify-center rounded-full bg-red-500/20 text-red-400">
      <Skull size={30} />
    </span>
    <p class="text-xl font-black tracking-wide text-white">
      {self.deathBy ? `被 ${self.deathBy} 击杀了` : "撞到了边界"}
    </p>

    <div class="mt-4 grid w-full grid-cols-2 gap-2">
      <div class="flex flex-col items-center rounded-2xl bg-white/5 py-2.5">
        <Ruler size={14} class="mb-0.5 text-lime-300" />
        <span class="tnum text-lg font-black text-white">{self.length}</span>
        <span class="text-xs text-white/50">长度</span>
      </div>
      <div class="flex flex-col items-center rounded-2xl bg-white/5 py-2.5">
        <Sword size={14} class="mb-0.5 text-red-400" />
        <span class="tnum text-lg font-black text-white">{self.kills}</span>
        <span class="text-xs text-white/50">击杀</span>
      </div>
    </div>

    <p class="mt-4 text-sm font-bold text-white/70">
      {#if countdown > 0}
        <span class="tnum text-lg font-black text-lime-300">{countdown}</span> 秒后重生
      {:else}
        即将重生…
      {/if}
    </p>
  </div>
</div>
