<script lang="ts">
  import Skull from "lucide-svelte/icons/skull";
  import type { KillFeedEntry } from "$lib/client/game.svelte";

  let { feed }: { feed: ReadonlyArray<KillFeedEntry> } = $props();
</script>

<div class="pointer-events-none flex flex-col items-center gap-1.5">
  {#each feed as entry (entry.id)}
    <div
      class="feed-in flex items-center gap-1.5 rounded-full border border-panel-border bg-panel px-4 py-1 text-xs font-bold text-white/90 backdrop-blur-sm"
    >
      <Skull size={12} class="text-red-400" />
      {entry.text}
    </div>
  {/each}
</div>
