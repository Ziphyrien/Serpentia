<script lang="ts">
  import Trophy from "lucide-svelte/icons/trophy";

  let {
    entries,
    selfId,
  }: {
    entries: ReadonlyArray<{ playerId: string; nickname: string; length: number; kills: number }>;
    selfId: string | undefined;
  } = $props();

  const RANK_COLORS = ["text-amber-300", "text-slate-300", "text-orange-400"];
</script>

<div
  class="w-44 rounded-2xl border border-panel-border bg-panel p-3 backdrop-blur-sm sm:w-52 landscape-short:max-h-[42dvh] landscape-short:overflow-y-auto"
>
  <div class="mb-2 flex items-center gap-1.5 text-white/85">
    <Trophy size={15} class="text-amber-300" />
    <span class="text-sm font-black tracking-wide">排行榜</span>
  </div>
  <ol class="flex flex-col gap-1">
    {#each entries as entry, index (entry.playerId)}
      <li
        class="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs {entry.playerId === selfId
          ? 'bg-lime-300/20'
          : ''}"
      >
        <span class="w-4 shrink-0 text-center font-black {RANK_COLORS[index] ?? 'text-white/50'}">
          {index + 1}
        </span>
        <span class="min-w-0 flex-1 truncate font-semibold text-white/90">{entry.nickname}</span>
        <span class="tnum shrink-0 font-bold text-white/60">{entry.length}</span>
      </li>
    {:else}
      <li class="px-1.5 text-xs text-white/40">虚位以待</li>
    {/each}
  </ol>
</div>
