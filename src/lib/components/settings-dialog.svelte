<script lang="ts">
  import { Dialog, mergeProps } from "bits-ui";
  import Settings from "lucide-svelte/icons/settings";
  import LogOut from "lucide-svelte/icons/log-out";
  import X from "lucide-svelte/icons/x";
  import type { SettingsStore } from "$lib/client/stores/settings.svelte";
  import type { Sfx } from "$lib/client/audio/sfx";
  import Button from "./ui/button.svelte";
  import Switch from "./ui/switch.svelte";
  import Slider from "./ui/slider.svelte";

  let {
    settings,
    sfx,
    onLogout,
  }: {
    settings: SettingsStore;
    sfx: Sfx;
    onLogout: () => void;
  } = $props();

  let open = $state(false);

  // 设置变化即时生效到音效层（UI → 音效的单一出口）
  $effect(() => sfx.setVolume(settings.sfxVolume));
  $effect(() => sfx.setMuted(settings.sfxMuted));
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button
        {...mergeProps(props, { onclick: () => sfx.click() })}
        intent="ghost"
        size="icon"
        aria-label="设置"
      >
        <Settings size={19} />
      </Button>
    {/snippet}
  </Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-night-950/70 backdrop-blur-sm" />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(92vw,22rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-panel-border bg-night-900 p-6 shadow-2xl"
    >
      <div class="mb-5 flex items-center justify-between">
        <Dialog.Title class="text-lg font-black tracking-wide">设置</Dialog.Title>
        <Dialog.Close class="cursor-pointer rounded-full p-1 text-white/60 transition hover:bg-white/10 hover:text-white">
          <X size={18} />
        </Dialog.Close>
      </div>

      <div class="flex flex-col gap-5">
        <div class="flex items-center justify-between gap-4">
          <span class="text-sm font-bold text-white/85">音效音量</span>
          <div class="w-32">
            <Slider bind:value={settings.sfxVolume} onValueChange={() => sfx.click()} />
          </div>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-sm font-bold text-white/85">静音</span>
          <Switch bind:checked={settings.sfxMuted} />
        </div>
        <div class="flex items-center justify-between">
          <span class="text-sm font-bold text-white/85">显示昵称</span>
          <Switch bind:checked={settings.showNicknames} />
        </div>
        <div class="flex items-center justify-between">
          <span class="text-sm font-bold text-white/85">高清画质</span>
          <Switch bind:checked={settings.highQuality} />
        </div>
      </div>

      <div class="mt-7 border-t border-white/10 pt-5">
        <Button intent="danger" class="w-full" onclick={onLogout}>
          <LogOut size={15} />
          退出登录
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
