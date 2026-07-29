<script lang="ts">
  import { page } from "$app/state";
</script>

<svelte:head>
  <title>页面出错了 · 蛇域</title>
</svelte:head>

<div
  class="game-map-background flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-map-ink"
>
  <h1 class="text-2xl font-black text-map-border">页面出错了</h1>
  <p class="max-w-md text-center font-bold">{page.error?.message ?? "请刷新页面后重试"}</p>
  <div class="flex gap-3">
    <button
      type="button"
      class="rounded-full bg-map-border px-6 py-2.5 font-black text-white"
      onclick={() => location.reload()}
    >
      刷新页面
    </button>
    <a class="rounded-full bg-white/90 px-6 py-2.5 font-black text-map-border" href="/">
      返回首页
    </a>
  </div>
</div>
