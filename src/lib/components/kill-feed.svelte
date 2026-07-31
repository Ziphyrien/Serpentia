<script lang="ts">
  import Skull from "lucide-svelte/icons/skull";
  import type { KillFeedEntry } from "$lib/client/game.svelte";

  let { feed }: { feed: ReadonlyArray<KillFeedEntry> } = $props();
</script>

<div class="kill-feed pointer-events-none flex flex-col items-center">
  {#each feed as entry (entry.id)}
    <div
      class="kill-feed-item feed-in flex items-center rounded-full border border-panel-border bg-panel text-xs font-bold text-white/90 backdrop-blur-sm"
    >
      <Skull size={12} class="text-red-400" />
      {entry.text}
    </div>
  {/each}
</div>

<style>
  .kill-feed {
    gap: clamp(0.25rem, calc(0.8 * var(--game-vh, 1dvh)), 0.375rem);
  }

  .kill-feed-item {
    gap: clamp(0.25rem, calc(0.8 * var(--game-vh, 1dvh)), 0.375rem);
    padding-block: clamp(0.125rem, calc(0.533 * var(--game-vh, 1dvh)), 0.25rem);
    padding-inline: clamp(0.75rem, calc(2.133 * var(--game-vh, 1dvh)), 1rem);
  }

  .feed-in {
    animation: feed-in 0.18s ease-out;
  }

  @keyframes feed-in {
    from {
      opacity: 0;
      transform: translateY(-8px) scale(0.95);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
</style>
