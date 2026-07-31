<script lang="ts">
  import { Dialog, mergeProps } from "bits-ui";
  import Settings from "lucide-svelte/icons/settings";
  import House from "lucide-svelte/icons/house";
  import X from "lucide-svelte/icons/x";
  import { pseudoLandscape } from "$lib/client/pseudo-landscape.svelte";
  import type { SettingsStore } from "$lib/client/stores/settings.svelte";
  import type { Sfx } from "$lib/client/audio/sfx";
  import Button from "./ui/button.svelte";
  import Switch from "./ui/switch.svelte";
  import Slider from "./ui/slider.svelte";

  let {
    settings,
    sfx,
    onReturnHome,
  }: {
    settings: SettingsStore;
    sfx: Sfx;
    onReturnHome: () => void;
  } = $props();

  let open = $state(false);

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
      class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(92vw,22rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-panel-border bg-night-900 p-6 text-white shadow-2xl {pseudoLandscape.active ? 'dialog-pseudo' : ''}"
    >
      <div class="mb-5 flex items-center justify-between">
        <Dialog.Title class="text-lg font-black tracking-wide">设置</Dialog.Title>
        <Dialog.Close class="cursor-pointer rounded-full p-1 text-white/60 transition hover:text-white">
          <X size={18} />
        </Dialog.Close>
      </div>

      <div class="flex flex-col gap-5">
        <div class="flex items-center justify-between gap-4">
          <span class="text-sm font-bold text-white/85">音效音量</span>
          <div class="w-32">
            <Slider
              value={settings.sfxVolume}
              onValueChange={(value) => {
                settings.setSfxVolume(value);
                sfx.click();
              }}
            />
          </div>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-sm font-bold text-white/85">静音</span>
          <Switch checked={settings.sfxMuted} onCheckedChange={(value) => settings.setSfxMuted(value)} />
        </div>
        <div class="flex items-center justify-between">
          <span class="text-sm font-bold text-white/85">显示昵称</span>
          <Switch
            checked={settings.showNicknames}
            onCheckedChange={(value) => settings.setShowNicknames(value)}
          />
        </div>
      </div>

      <div class="mt-7 border-t border-white/10 pt-5">
        <Button intent="danger" class="w-full" onclick={onReturnHome}>
          <House size={15} />
          返回首页
        </Button>
      </div>
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
</style>
