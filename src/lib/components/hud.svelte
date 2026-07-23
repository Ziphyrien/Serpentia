<script lang="ts">
  import Ruler from "lucide-svelte/icons/ruler";
  import Sword from "lucide-svelte/icons/sword";
  import type { GameController } from "$lib/client/game.svelte";
  import type { SettingsStore } from "$lib/client/stores/settings.svelte";
  import Leaderboard from "./leaderboard.svelte";
  import KillFeed from "./kill-feed.svelte";
  import MinimapPanel from "./minimap-panel.svelte";
  import DeathOverlay from "./death-overlay.svelte";
  import VoicePanel from "./voice-panel.svelte";
  import SettingsDialog from "./settings-dialog.svelte";
  import TouchControls from "./touch-controls.svelte";

  let {
    controller,
    settings,
    onLogout,
  }: {
    controller: GameController;
    settings: SettingsStore;
    onLogout: () => void;
  } = $props();

  const isTouch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  const showTouch = $derived(isTouch && controller.self.alive);

  let hintVisible = $state(true);
  $effect(() => {
    const timer = setTimeout(() => (hintVisible = false), 6000);
    return () => clearTimeout(timer);
  });
</script>

<div class="pointer-events-none absolute inset-0 z-10 flex flex-col p-hud" data-ui>
  <!-- 顶部行：排行榜 / 击杀播报 / 小地图与按钮 -->
  <div class="flex items-start justify-between gap-3">
    <Leaderboard entries={controller.leaderboard} selfId={controller.selfId} />
    <div class="flex-1 pt-1">
      <KillFeed feed={controller.killFeed} />
    </div>
    <div class="pointer-events-auto flex flex-col items-end gap-2">
      <MinimapPanel {controller} />
      <div class="flex gap-2">
        <VoicePanel {controller} />
        <SettingsDialog {settings} sfx={controller.sfx} {onLogout} />
      </div>
    </div>
  </div>

  <!-- 左下：自己的数据 -->
  <div class="mt-auto flex items-end justify-between">
    <div class="flex gap-2">
      <div class="flex items-center gap-1.5 rounded-full border border-panel-border bg-panel px-4 py-1.5 backdrop-blur-sm">
        <Ruler size={14} class="text-lime-300" />
        <span class="tnum text-base font-black text-white">{controller.self.length}</span>
      </div>
      <div class="flex items-center gap-1.5 rounded-full border border-panel-border bg-panel px-4 py-1.5 backdrop-blur-sm">
        <Sword size={14} class="text-red-400" />
        <span class="tnum text-base font-black text-white">{controller.self.kills}</span>
      </div>
      {#if controller.pingMs > 0}
        <div class="hidden items-center rounded-full border border-panel-border bg-panel px-3 py-1.5 backdrop-blur-sm sm:flex">
          <span class="tnum text-xs font-bold text-white/50">{controller.pingMs}ms</span>
        </div>
      {/if}
    </div>
  </div>

  <!-- 桌面端操作提示（短暂显示） -->
  {#if !isTouch && hintVisible}
    <div class="absolute inset-x-0 bottom-16 flex justify-center transition-opacity duration-700">
      <p class="rounded-full bg-panel px-5 py-1.5 text-xs font-bold text-white/60 backdrop-blur-sm">
        移动鼠标控制方向 · 按住左键或空格加速
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
