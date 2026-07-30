<script lang="ts">
  import Crown from "lucide-svelte/icons/crown";
  import MapPin from "lucide-svelte/icons/map-pin";
  import {
    projectGameMapPoint,
    type GameMapMarker,
  } from "$lib/client/hud/game-hud";

  let {
    markers,
    arenaHalfSize,
  }: {
    markers: ReadonlyArray<GameMapMarker>;
    arenaHalfSize: number;
  } = $props();

  function rankColor(rank: number | undefined): string {
    if (rank === 2) return "text-slate-300";
    if (rank === 3) return "text-orange-400";
    return "text-amber-300";
  }

  function markerOffset(value: number): string {
    return `clamp(0.625rem, ${value}%, calc(100% - 0.625rem))`;
  }
</script>

<div
  class="map-field relative aspect-square overflow-hidden border border-panel-border bg-panel backdrop-blur-sm"
  aria-label="小地图"
>
  {#each markers as marker (`${marker.kind}:${marker.playerId}`)}
    {@const point = projectGameMapPoint(marker.position, arenaHalfSize, marker.kind === "me", 100)}
    {#if point}
      <span
        class="absolute grid -translate-x-1/2 -translate-y-1/2 place-items-center"
        class:z-20={marker.kind === "me"}
        class:z-10={marker.kind === "top"}
        style:left={markerOffset(point.left)}
        style:top={markerOffset(point.top)}
        aria-label={marker.kind === "me" ? "我的位置" : `第 ${marker.rank ?? 1} 名的位置`}
      >
        {#if marker.kind === "top"}
          <Crown size={17} strokeWidth={3} class={rankColor(marker.rank)} />
        {:else if marker.kind === "player"}
          <span
            class="grid size-4 place-items-center rounded-full bg-slate-800/80 text-[10px] leading-none font-bold text-slate-200 ring-1 ring-white/25"
          >
            {marker.rank}
          </span>
        {:else}
          <MapPin size={18} strokeWidth={3} class="fill-lime-300/20 text-lime-300" />
        {/if}
      </span>
    {/if}
  {/each}
</div>

<style>
  .map-field {
    width: clamp(7rem, 27.733dvh, 13rem);
    border-radius: clamp(0.75rem, 2.133dvh, 1rem);
    background-image:
      linear-gradient(rgb(255 255 255 / 7%) 1px, transparent 1px),
      linear-gradient(90deg, rgb(255 255 255 / 7%) 1px, transparent 1px);
    background-position: center;
    background-size: 25% 25%;
  }
</style>
