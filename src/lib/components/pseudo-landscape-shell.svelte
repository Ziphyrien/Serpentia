<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import {
    installPseudoLandscape,
    pseudoLandscape,
  } from "$lib/client/pseudo-landscape.svelte";

  let { children, class: className }: { children: Snippet; class?: string } = $props();

  onMount(() => installPseudoLandscape());
</script>

<div class="pseudo-landscape-shell @container {className ?? ''}"
  class:pseudo-landscape={pseudoLandscape.active}
>
  {@render children()}
</div>

<style>
  .pseudo-landscape-shell {
    /* 游戏 UI 以 var(--game-vh) 作为“画面高度”缩放基准，伪横屏下换成 1dvw */
    --game-vh: 1dvh;
  }

  /*
   * 伪横屏：竖屏下把画面宽高互换并顺时针旋转 90°，
   * 让内容按横屏尺寸布局，用户向左旋转设备使用。
   */
  .pseudo-landscape {
    --game-vh: 1dvw;
    position: fixed;
    inset: auto;
    top: 50%;
    left: 50%;
    width: 100dvh;
    height: 100dvw;
    transform: translate(-50%, -50%) rotate(90deg);
    overflow: hidden;
  }
</style>
