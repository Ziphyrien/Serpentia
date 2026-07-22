<script lang="ts">
  import { onMount } from "svelte";
  import { Minimap } from "$lib/client/render/minimap";
  import type { GameController } from "$lib/client/game.svelte";

  let { controller }: { controller: GameController } = $props();

  let canvas = $state<HTMLCanvasElement>();

  onMount(() => {
    if (!canvas) return;
    const minimap = new Minimap(canvas, controller.descriptor.rules.arenaHalfSize);
    const timer = setInterval(
      () => minimap.render(controller.latestSnapshot, controller.selfId),
      180,
    );
    minimap.render(controller.latestSnapshot, controller.selfId);
    return () => clearInterval(timer);
  });
</script>

<canvas
  bind:this={canvas}
  width="148"
  height="148"
  class="size-32 rounded-2xl border border-panel-border bg-panel backdrop-blur-sm sm:size-37"
></canvas>
