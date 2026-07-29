<script lang="ts">
  import ArrowLeft from "lucide-svelte/icons/arrow-left";
  import Check from "lucide-svelte/icons/check";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import { INTERNAL_SKINS } from "$lib/game/internal-skins";
  import SnakeSkinPreview from "./snake-skin-preview.svelte";

  let {
    selectedSkinId,
    onSelect,
    onClose,
  }: {
    selectedSkinId: number;
    onSelect: (skinId: number) => void;
    onClose: () => void;
  } = $props();

  let scrollViewport = $state<HTMLElement>();
  let skinGrid = $state<HTMLDivElement>();
  let showScrollHint = $state(false);

  function updateScrollHint(): void {
    const viewport = scrollViewport;
    showScrollHint =
      viewport !== undefined &&
      viewport.scrollTop <= 1 &&
      viewport.scrollHeight > viewport.clientHeight + 1;
  }

  $effect(() => {
    const viewport = scrollViewport;
    const grid = skinGrid;
    if (viewport === undefined || grid === undefined) return;

    const observer = new ResizeObserver(updateScrollHint);
    observer.observe(viewport);
    observer.observe(grid);
    updateScrollHint();
    return () => observer.disconnect();
  });
</script>

<div class="game-map-background fixed inset-0 z-50 overflow-hidden text-map-ink">
  <div class="relative flex h-full flex-col">
    <header class="safe-panel-padding flex items-center justify-between border-b border-map-grid bg-map-floor/90 backdrop-blur-sm">
      <button
        type="button"
        aria-label="返回"
        onclick={onClose}
        class="flex size-11 items-center justify-center rounded-full border border-map-grid bg-white/90 text-map-ink shadow-sm transition hover:border-map-border hover:text-map-border active:scale-95"
      >
        <ArrowLeft size={22} />
      </button>
      <h1 class="text-2xl font-black tracking-[0.25em] text-map-border">选择皮肤</h1>
      <div class="size-11"></div>
    </header>

    <div class="relative min-h-0 flex-1">
      <main
        bind:this={scrollViewport}
        aria-label="可滚动皮肤列表"
        class="h-full touch-pan-y overflow-y-auto overscroll-contain px-4 py-5 sm:px-7"
        onscroll={updateScrollHint}
      >
        <div
          bind:this={skinGrid}
          class="mx-auto grid max-w-6xl grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
        >
          {#each INTERNAL_SKINS as skin (skin.id)}
            <button
              type="button"
              aria-label={`选择皮肤 ${skin.id}`}
              aria-pressed={selectedSkinId === skin.id}
              onclick={() => onSelect(skin.id)}
              class="relative flex touch-pan-y items-center justify-center overflow-hidden rounded-3xl border-2 bg-white/80 p-1 backdrop-blur-sm {selectedSkinId === skin.id
                ? 'border-map-border ring-4 ring-map-border/15'
                : 'border-white/90'}"
            >
              <SnakeSkinPreview {skin} width={190} height={88} />
              {#if selectedSkinId === skin.id}
                <span class="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-map-border text-white">
                  <Check size={14} strokeWidth={3} />
                </span>
              {/if}
            </button>
          {/each}
        </div>
      </main>

      {#if showScrollHint}
        <div
          class="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center bg-linear-to-t from-map-floor via-map-floor/90 to-transparent pt-10 pb-3"
          aria-hidden="true"
        >
          <span class="flex items-center gap-1 rounded-full bg-white/90 px-4 py-1.5 text-xs font-black text-map-ink backdrop-blur-sm">
            向下滑动查看更多
            <ChevronDown size={16} strokeWidth={3} />
          </span>
        </div>
      {/if}
    </div>

    <footer class="safe-panel-padding border-t border-map-grid bg-map-floor/92 backdrop-blur-sm">
      <button
        type="button"
        onclick={onClose}
        class="mx-auto flex h-13 w-full max-w-sm items-center justify-center rounded-full bg-map-border text-base font-black tracking-widest text-white shadow-[0_5px_0_#c83255,0_10px_24px_rgba(235,79,113,0.22)] transition active:translate-y-1 active:shadow-[0_1px_0_#c83255]"
      >
        使用此皮肤
      </button>
    </footer>
  </div>
</div>

<style>
  .safe-panel-padding {
    padding-top: max(0.75rem, var(--hud-safe-top));
    padding-right: max(0.75rem, var(--hud-safe-right));
    padding-bottom: max(0.75rem, var(--hud-safe-bottom));
    padding-left: max(0.75rem, var(--hud-safe-left));
  }
</style>
