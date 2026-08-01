<script lang="ts">
  import { onMount, untrack } from "svelte";
  import Gamepad2 from "lucide-svelte/icons/gamepad-2";
  import type { GameController } from "$lib/client/game.svelte";
  import { MusicLibrary } from "$lib/client/net/music-library.svelte";
  import type { SettingsStore } from "$lib/client/stores/settings.svelte";
  import Leaderboard from "./leaderboard.svelte";
  import GameMap from "./game-map.svelte";
  import GameState from "./game-state.svelte";
  import MagnetStatus from "./magnet-status.svelte";
  import NetStatus from "./net-status.svelte";
  import KillFeed from "./kill-feed.svelte";
  import DeathOverlay from "./death-overlay.svelte";
  import VoicePanel from "./voice-panel.svelte";
  import SettingsDialog from "./settings-dialog.svelte";
  import MusicDialog from "./music-dialog.svelte";
  import TouchControls from "./touch-controls.svelte";

  let {
    controller,
    settings,
    onReturnHome,
  }: {
    controller: GameController;
    settings: SettingsStore;
    onReturnHome: () => void;
  } = $props();

  const isTouch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  const showTouch = $derived(isTouch && controller.self.alive && !controller.gamepadConnected);

  // 音乐管理弹窗的数据层：打开设置菜单即预热后端状态，点开时大概率零加载态
  const musicLibrary = MusicLibrary.fromDescriptor(untrack(() => controller).descriptor);
  onMount(() => () => musicLibrary.dispose());

  let hintVisible = $state(true);

  $effect(() => {
    const gamepadConnected = controller.gamepadConnected;
    hintVisible = true;
    const timer = setTimeout(() => {
      if (controller.gamepadConnected === gamepadConnected) hintVisible = false;
    }, 6000);
    return () => clearTimeout(timer);
  });
</script>

<div class="game-hud pointer-events-none absolute inset-0 z-10 flex flex-col" data-game-hud data-ui>
  <div class="hud-row flex items-start">
    <div class="hud-left flex shrink-0 items-start">
      <Leaderboard entries={controller.leaderboard} selfId={controller.selfId} />
      <div class="hud-meta flex flex-col items-start">
        <GameState kills={controller.self.kills} />
        {#if controller.pingMs > 0}
          <NetStatus pingMs={controller.pingMs} />
        {/if}
        {#if controller.gamepadConnected}
          <div
            class="hud-gamepad flex items-center rounded-full border border-panel-border bg-panel backdrop-blur-sm"
            title={controller.gamepadName}
          >
            <Gamepad2 size={15} class="text-amber-300" />
            <span class="hidden text-xs font-bold text-white/70 lg:inline">手柄</span>
          </div>
        {/if}
      </div>
    </div>

    <div class="hud-center min-w-0 flex-1">
      <KillFeed feed={controller.killFeed} />
    </div>

    <div class="hud-right flex shrink-0 flex-col items-end">
      <div class="hud-actions pointer-events-auto flex">
        <VoicePanel {controller} />
        <SettingsDialog
          {settings}
          sfx={controller.sfx}
          music={controller.music}
          onManageMusic={() => controller.requestMusicManager()}
          onMenuOpenChange={(open) => {
            controller.setMenuOpen("settings", open);
            if (open) musicLibrary.warm();
          }}
          {onReturnHome}
        />
      </div>
      <GameMap
        markers={controller.gameMapMarkers}
        arenaHalfSize={controller.descriptor.rules.arenaHalfSize}
      />
    </div>
  </div>

  <MagnetStatus remaining={controller.self.magnetRemaining} />

  {#if hintVisible && controller.self.alive && (controller.gamepadConnected || !isTouch)}
    <div class="absolute inset-x-0 bottom-16 flex justify-center transition-opacity duration-700">
      <p class="rounded-full bg-panel px-5 py-1.5 text-xs font-bold text-white/60 backdrop-blur-sm">
        {controller.gamepadConnected
          ? "左摇杆或方向键控制方向 · 面键、肩键或扳机加速"
          : "移动鼠标控制方向 · 按住左键或空格加速"}
      </p>
    </div>
  {/if}
</div>

{#if !controller.self.alive}
  <DeathOverlay self={controller.self} />
{/if}

{#if showTouch}
  <TouchControls {controller} />
{/if}

<MusicDialog {controller} library={musicLibrary} />

<style>
  .game-hud {
    --hud-gap: clamp(0.5rem, calc(1.6 * var(--game-vh, 1dvh)), 0.75rem);
    --hud-small-gap: clamp(0.375rem, calc(1.067 * var(--game-vh, 1dvh)), 0.5rem);

    padding: var(--hud-gap);
  }

  .hud-row,
  .hud-right,
  .hud-actions {
    gap: var(--hud-gap);
  }

  .hud-left,
  .hud-meta {
    gap: var(--hud-small-gap);
  }

  .hud-center,
  .hud-meta {
    padding-top: clamp(0.125rem, calc(0.533 * var(--game-vh, 1dvh)), 0.25rem);
  }

  .hud-gamepad {
    gap: clamp(0.25rem, calc(0.8 * var(--game-vh, 1dvh)), 0.375rem);
    padding-block: clamp(0.25rem, calc(0.8 * var(--game-vh, 1dvh)), 0.375rem);
    padding-inline: clamp(0.625rem, calc(2 * var(--game-vh, 1dvh)), 0.75rem);
  }
</style>
