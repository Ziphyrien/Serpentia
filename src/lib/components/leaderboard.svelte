<script lang="ts">
  import Trophy from "lucide-svelte/icons/trophy";
  import type { HudRankEntry } from "$lib/client/hud/game-hud";

  let {
    entries,
    selfId,
  }: {
    entries: ReadonlyArray<HudRankEntry>;
    selfId: string | undefined;
  } = $props();

  function rankColor(rank: number): string {
    if (rank === 1) return "text-amber-300";
    if (rank === 2) return "text-slate-300";
    if (rank === 3) return "text-orange-400";
    return "text-white/50";
  }
</script>

<div
  class="leaderboard-card rounded-2xl border border-panel-border bg-panel backdrop-blur-sm"
  aria-label="排行榜"
>
  <div class="leaderboard-header flex items-center text-white/85">
    <Trophy size={15} class="text-amber-300" />
    <span class="font-black tracking-wide">排行榜</span>
  </div>
  <ol class="leaderboard-list flex flex-col">
    {#each entries as entry (entry.playerId)}
      <li
        class="leaderboard-row flex items-center rounded-md text-xs {entry.playerId === selfId
          ? 'bg-lime-300/20'
          : ''}"
      >
        <span class="w-4 shrink-0 text-center font-black {rankColor(entry.rank)}">
          {entry.rank}
        </span>
        <span class="min-w-0 flex-1 truncate font-semibold text-white/90" title={entry.nickname}>
          {entry.nickname}
        </span>
        <span class="tnum shrink-0 font-bold text-white/60">{entry.score}</span>
      </li>
    {:else}
      <li class="px-1.5 text-xs text-white/40">虚位以待</li>
    {/each}
  </ol>
</div>

<style>
  .leaderboard-card {
    width: clamp(9rem, calc(27.733 * var(--game-vh, 1dvh)), 13rem);
    max-height: calc(36 * var(--game-vh, 1dvh));
    overflow-y: auto;
    border-radius: clamp(0.75rem, calc(2.133 * var(--game-vh, 1dvh)), 1rem);
    padding: clamp(0.5rem, calc(1.6 * var(--game-vh, 1dvh)), 0.75rem);
  }

  .leaderboard-header {
    gap: clamp(0.25rem, calc(0.8 * var(--game-vh, 1dvh)), 0.375rem);
    margin-bottom: clamp(0.25rem, calc(1.067 * var(--game-vh, 1dvh)), 0.5rem);
    font-size: clamp(0.75rem, calc(1.867 * var(--game-vh, 1dvh)), 0.875rem);
  }

  .leaderboard-list {
    gap: clamp(0.125rem, calc(0.533 * var(--game-vh, 1dvh)), 0.25rem);
  }

  .leaderboard-row {
    gap: clamp(0.25rem, calc(0.8 * var(--game-vh, 1dvh)), 0.375rem);
    padding-block: clamp(0rem, calc(0.267 * var(--game-vh, 1dvh)), 0.125rem);
    padding-inline: clamp(0.25rem, calc(0.8 * var(--game-vh, 1dvh)), 0.375rem);
  }
</style>
