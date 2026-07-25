<script lang="ts">
  import { Dialog, mergeProps } from "bits-ui";
  import Headphones from "lucide-svelte/icons/headphones";
  import Mic from "lucide-svelte/icons/mic";
  import MicOff from "lucide-svelte/icons/mic-off";
  import X from "lucide-svelte/icons/x";
  import type { GameController } from "$lib/client/game.svelte";
  import type { VoicePeerView } from "$lib/client/voice/voice-manager";
  import Button from "./ui/button.svelte";
  import Switch from "./ui/switch.svelte";
  import Slider from "./ui/slider.svelte";

  let { controller }: { controller: GameController } = $props();

  let open = $state(false);

  const talkingCount = $derived(controller.voicePeers.filter((peer) => peer.microphoneEnabled).length);
  const micLive = $derived(controller.voiceJoined && !controller.voiceMuted);
  const selfStatus = $derived.by(() => {
    if (!controller.voiceJoined) return "收听中";
    return controller.voiceMuted ? "已静音" : "通话中";
  });

  function peerStatus(peer: VoicePeerView): string {
    if (!peer.microphoneEnabled) return "收听中";
    if (peer.muted) return "已静音";
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
      class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(92vw,22rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-panel-border bg-night-900 p-6 shadow-2xl"
    >
      <div class="mb-5 flex items-center justify-between">
        <Dialog.Title class="text-lg font-black tracking-wide">队伍语音</Dialog.Title>
        <Dialog.Close class="cursor-pointer rounded-full p-1 text-white/60 transition hover:bg-white/10 hover:text-white">
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
        {#if controller.voiceJoined}
          <div class="flex items-center gap-2">
            <span class="text-xs text-white/50">静音</span>
            <Switch checked={controller.voiceMuted} onCheckedChange={(v) => controller.setVoiceMuted(v)} />
          </div>
        {/if}
      </div>

      <Button
        intent={controller.voiceJoined ? "danger" : "primary"}
        class="mb-5 w-full"
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

      <div class="flex max-h-56 flex-col gap-2 overflow-y-auto">
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
                {:else if peer.muted}
                  <MicOff size={15} />
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
                <span class="text-xs text-white/40">音量</span>
                <Slider
                  value={peer.volume}
                  onValueChange={(v) => controller.setPeerVolume(peer.playerId, v)}
                />
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
