<script lang="ts">
  import Sword from "lucide-svelte/icons/sword";

  let { kills }: { kills: number } = $props();
</script>

<div class="flex" aria-label={`击杀 ${kills}`}>
  <div
    class="hud-state flex items-center rounded-full border border-panel-border bg-panel backdrop-blur-sm"
    title="击杀"
  >
    <Sword size={14} class="text-red-400" aria-hidden="true" />
    <span class="tnum hud-kills font-black text-white">{kills}</span>
  </div>
</div>

<style>
  .hud-state {
    gap: clamp(0.25rem, calc(0.8 * var(--game-vh, 1dvh)), 0.375rem);
    padding-block: clamp(0.25rem, calc(0.8 * var(--game-vh, 1dvh)), 0.375rem);
    padding-inline: clamp(0.75rem, calc(2.133 * var(--game-vh, 1dvh)), 1rem);
  }

  .hud-kills {
    font-size: clamp(0.875rem, calc(2.133 * var(--game-vh, 1dvh)), 1rem);
  }
</style>
