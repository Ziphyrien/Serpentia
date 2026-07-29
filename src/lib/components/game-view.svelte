<script lang="ts">
  import { onMount } from "svelte";
  import { GameController } from "$lib/client/game.svelte";
  import { gamePresentationPhase } from "$lib/client/game-readiness";
  import type { SessionState } from "$lib/client/stores/session.svelte";
  import type { SettingsStore } from "$lib/client/stores/settings.svelte";
  import Hud from "./hud.svelte";

  let {
    session,
    settings,
    onReturnHome,
    onSessionExpired,
  }: {
    session: Extract<SessionState, { status: "authenticated" }>;
    settings: SettingsStore;
    onReturnHome: () => void | Promise<void>;
    onSessionExpired: () => void;
  } = $props();

  let canvasHost = $state<HTMLDivElement>();
  let controller = $state<GameController>();
  const presentationPhase = $derived(
    controller === undefined
      ? "loading"
      : gamePresentationPhase(controller.status, controller.gameReady),
  );

  onMount(() => {
    const activeController = new GameController(
      session.descriptor,
      session.session,
      settings,
      onSessionExpired,
    );
    controller = activeController;
    if (canvasHost) void activeController.attachRenderer(canvasHost);
    return () => {
      activeController.destroy();
      if (controller === activeController) controller = undefined;
    };
  });
</script>

<div class="game-map-background fixed inset-0 overflow-hidden">
  <div bind:this={canvasHost} class="absolute inset-0" data-game-canvas></div>

  {#if controller !== undefined && presentationPhase === "closed"}
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
  {:else if presentationPhase === "loading" || presentationPhase === "reconnecting"}
    <div class="game-loading-notice absolute inset-x-0 top-0 z-30 flex justify-center">
      <div class="rounded-full bg-panel px-6 py-2 text-sm font-bold text-white/90 backdrop-blur-sm">
        {presentationPhase === "reconnecting" ? "连接断了，正在重连…" : "正在进入蛇域…"}
      </div>
    </div>
  {/if}

  {#if controller !== undefined && (presentationPhase === "ready" || presentationPhase === "reconnecting")}
    <Hud {controller} {settings} onReturnHome={() => void onReturnHome()} />
  {/if}
</div>

<style>
  .game-loading-notice {
    padding-top: 5rem;
  }

  @media (orientation: landscape) and (max-height: 30rem) {
    .game-loading-notice {
      padding-top: 3rem;
    }
  }
</style>
