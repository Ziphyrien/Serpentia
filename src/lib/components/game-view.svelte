<script lang="ts">
  import { onMount } from "svelte";
  import { GameController } from "$lib/client/game.svelte";
  import type { SessionStore } from "$lib/client/stores/session.svelte";
  import type { SettingsStore } from "$lib/client/stores/settings.svelte";
  import Hud from "./hud.svelte";

  let {
    session,
    settings,
    sessionStore,
  }: {
    session: Extract<SessionStore["state"], { status: "authenticated" }>;
    settings: SettingsStore;
    sessionStore: SessionStore;
  } = $props();

  let canvasHost = $state<HTMLDivElement>();
  // 组件仅在已认证分支渲染，登录态变化会整树重建，这里只需读取一次初始 props
  /* svelte-ignore state_referenced_locally */
  const controller = new GameController(session.descriptor, session.session, settings, () =>
    sessionStore.markExpired(),
  );

  onMount(() => {
    if (canvasHost) void controller.attachRenderer(canvasHost);
    return () => controller.destroy();
  });
</script>

<div class="fixed inset-0 overflow-hidden bg-night-950">
  <!-- Pixi 画布挂载点 -->
  <div bind:this={canvasHost} class="absolute inset-0"></div>

  <!-- 边界警告红晕 -->
  {#if controller.nearBoundary}
    <div
      class="pointer-events-none absolute inset-0 transition-opacity duration-300"
      style="box-shadow: inset 0 0 120px 30px rgba(242, 109, 95, 0.45);"
    ></div>
  {/if}

  <!-- 连接状态横幅 -->
  {#if controller.status === "connecting" || controller.status === "reconnecting"}
    <div class="absolute inset-x-0 top-0 z-30 flex justify-center pt-20 landscape-short:pt-12">
      <div class="rounded-full bg-panel px-6 py-2 text-sm font-bold text-white/90 backdrop-blur-sm">
        {controller.status === "connecting" ? "正在进入蛇域…" : "连接断了，正在重连…"}
      </div>
    </div>
  {:else if controller.status === "closed"}
    <div class="absolute inset-0 z-30 flex items-center justify-center bg-night-950/80">
      <div class="flex flex-col items-center gap-4">
        <p class="text-lg font-bold text-white">{controller.notice ?? "连接已关闭"}</p>
        <button
          class="rounded-full bg-lime-400 px-8 py-2.5 font-black text-night-950 transition active:scale-95"
          onclick={() => location.reload()}
        >
          重新进入
        </button>
      </div>
    </div>
  {/if}

  <Hud {controller} {settings} onLogout={() => void sessionStore.logout()} />
</div>
