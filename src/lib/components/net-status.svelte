<script lang="ts">
  import Wifi from "lucide-svelte/icons/wifi";
  import { netStatusColor } from "$lib/client/hud/game-hud";

  let { pingMs }: { pingMs: number } = $props();
  const color = $derived(netStatusColor(pingMs));
</script>

<div
  class="hud-network flex w-fit items-center rounded-full border border-panel-border bg-panel backdrop-blur-sm"
  aria-label={`网络延迟 ${pingMs} 毫秒`}
>
  <span class="flex" style:color={color} aria-hidden="true">
    <Wifi size={14} />
  </span>
  <span class="tnum text-xs font-bold text-white/50">{pingMs}ms</span>
</div>

<style>
  .hud-network {
    gap: clamp(0.25rem, 0.8dvh, 0.375rem);
    padding-block: clamp(0.25rem, 0.8dvh, 0.375rem);
    padding-inline: clamp(0.625rem, 2dvh, 0.75rem);
  }
</style>
