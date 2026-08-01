<script lang="ts">
  import { untrack } from "svelte";
  import { Dialog, mergeProps } from "bits-ui";
  import Headphones from "lucide-svelte/icons/headphones";
  import Mic from "lucide-svelte/icons/mic";
  import MicOff from "lucide-svelte/icons/mic-off";
  import X from "lucide-svelte/icons/x";
  import { pseudoLandscape } from "$lib/client/pseudo-landscape.svelte";
  import type { GameController } from "$lib/client/game.svelte";
  import type { VoicePeerView } from "$lib/client/voice/voice-manager";
  import Button from "./ui/button.svelte";
  import Slider from "./ui/slider.svelte";

  let { controller }: { controller: GameController } = $props();

  let open = $state(false);

  $effect(() => {
    const active = open;
    untrack(() => controller.setMenuOpen("voice", active));
    return () => {
      if (active) untrack(() => controller.setMenuOpen("voice", false));
    };
  });

  const talkingCount = $derived(controller.voicePeers.filter((peer) => peer.microphoneEnabled).length);
  const micLive = $derived(controller.voiceJoined);
  const selfStatus = $derived.by(() => {
    return controller.voiceJoined ? "通话中" : "收听中";
  });

  function peerStatus(peer: VoicePeerView): string {
    if (!peer.microphoneEnabled) return "收听中";
    return peer.connected ? "已连接" : "连接中…";
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button
        {...mergeProps(props, { onclick: () => controller.sfx.click() })}
        intent="ghost"
        size="icon"
        aria-label="语音"
        class="relative {micLive ? 'text-lime-300' : ''}"
      >
        {#if micLive}
          <span class="mic-level-ring" style:--level={controller.voiceLevel}></span>
          <Mic size={19} />
        {:else}
          <MicOff size={19} />
        {/if}
        {#if talkingCount > 0}
          <span class="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-lime-400 text-[10px] font-black text-night-950">
            {talkingCount}
          </span>
        {/if}
      </Button>
    {/snippet}
  </Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-night-950/70 backdrop-blur-sm" />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(92vw,22rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-panel-border bg-night-900 p-6 text-white shadow-2xl {pseudoLandscape.active ? 'dialog-pseudo' : ''}"
    >
      <div class="mb-5 flex items-center justify-between">
        <Dialog.Title class="text-lg font-black tracking-wide">队伍语音</Dialog.Title>
        <Dialog.Close class="cursor-pointer rounded-full p-1 text-white/60 transition hover:text-white">
          <X size={18} />
        </Dialog.Close>
      </div>

      {#if controller.voiceError}
        <p class="mb-4 rounded-xl bg-red-500/20 px-4 py-2 text-xs font-bold text-red-300">
          {controller.voiceError}
        </p>
      {/if}

      <div class="mb-5 flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3">
        <div class="flex items-center gap-2.5">
          <span
            class="flex size-8 items-center justify-center rounded-full {micLive
              ? 'bg-lime-400/20 text-lime-300'
              : 'bg-white/10 text-white/60'}"
          >
            {#if micLive}
              <Mic size={15} />
            {:else}
              <Headphones size={15} />
            {/if}
          </span>
          <div>
            <p class="text-sm font-black text-white">我</p>
            <p class="text-xs text-white/50">{selfStatus}</p>
          </div>
        </div>
      </div>

      <Button
        intent={controller.voiceJoined ? "danger" : "primary"}
        class="w-full"
        onclick={() => controller.toggleVoice()}
      >
        {#if controller.voiceJoined}
          <MicOff size={15} />
          关闭麦克风
        {:else}
          <Mic size={15} />
          开启麦克风
        {/if}
      </Button>

      {#if controller.voicePeers.length > 0}
        <div class="mt-5 flex max-h-56 flex-col gap-2 overflow-y-auto">
          {#each controller.voicePeers as peer (peer.playerId)}
            <div class="rounded-2xl bg-white/5 px-4 py-3">
              <div class="flex items-center gap-2.5">
                <span
                  class="flex size-8 items-center justify-center rounded-full bg-white/10 text-white/80 {peer.speaking
                    ? 'speaking-ring'
                    : ''}"
                >
                  {#if !peer.microphoneEnabled}
                    <Headphones size={15} />
                  {:else}
                    <Mic size={15} />
                  {/if}
                </span>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-black text-white">{peer.nickname}</p>
                  <p class="text-xs text-white/50">{peerStatus(peer)}</p>
                </div>
              </div>
              {#if peer.microphoneEnabled}
                <div class="mt-2.5 flex items-center gap-2 pl-10">
                  <span class="text-xs text-white/50">音量</span>
                  <Slider
                    value={peer.volume}
                    onValueChange={(v) => controller.setPeerVolume(peer.playerId, v)}
                  />
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  /*
   * 伪横屏：弹框 Portal 到 body，不在旋转容器内，需自行顺时针旋转 90°，
   * 宽高约束换成旋转后的画面尺寸（画面宽 = 100dvh，画面高 = 100dvw）。
   */
  /* class 应用在 bits-ui 组件上，Svelte 无法静态识别，需 :global 防止裁剪 */
  :global(.dialog-pseudo) {
    width: min(92dvh, 22rem);
    max-height: calc(100dvw - 2rem);
    rotate: 90deg;
  }

  .speaking-ring {
    animation: pulse-ring 1.2s ease-out infinite;
  }

  .mic-level-ring {
    pointer-events: none;
    position: absolute;
    inset: -3px;
    border-radius: 9999px;
    background: conic-gradient(
      rgb(163 230 53 / 0.95) calc(var(--level, 0) * 360deg),
      rgb(163 230 53 / 0.15) 0deg
    );
    -webkit-mask: radial-gradient(
      farthest-side,
      transparent calc(100% - 4px),
      #000 calc(100% - 3px)
    );
    mask: radial-gradient(
      farthest-side,
      transparent calc(100% - 4px),
      #000 calc(100% - 3px)
    );
  }

  @keyframes pulse-ring {
    0% {
      box-shadow: 0 0 0 0 rgb(61 220 132 / 0.55);
    }
    70% {
      box-shadow: 0 0 0 12px rgb(61 220 132 / 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgb(61 220 132 / 0);
    }
  }
</style>
