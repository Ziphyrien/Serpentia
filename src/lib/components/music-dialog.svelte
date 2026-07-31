<script lang="ts">
  import { onMount } from "svelte";
  import { Dialog } from "bits-ui";
  import FastForward from "lucide-svelte/icons/fast-forward";
  import ListMusic from "lucide-svelte/icons/list-music";
  import LoaderCircle from "lucide-svelte/icons/loader-circle";
  import Music from "lucide-svelte/icons/music";
  import Pause from "lucide-svelte/icons/pause";
  import Play from "lucide-svelte/icons/play";
  import Rewind from "lucide-svelte/icons/rewind";
  import Square from "lucide-svelte/icons/square";
  import X from "lucide-svelte/icons/x";
  import { OPEN_MUSIC_MANAGER_EVENT, type GameController } from "$lib/client/game.svelte";
  import { MusicClient } from "$lib/client/net/music-client";
  import { pseudoLandscape } from "$lib/client/pseudo-landscape.svelte";
  import {
    MusicPauseControl,
    MusicPlayControl,
    MusicResumeControl,
    MusicSeekControl,
    MusicStopControl,
    type MusicPlaybackState,
    type MusicSourceStatusResponse,
  } from "$lib/protocol";
  import Button from "./ui/button.svelte";
  import Select from "./ui/select.svelte";

  let { controller }: { controller: GameController } = $props();

  const INPUT_CLASS =
    "w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-sm font-bold text-white outline-none transition placeholder:font-normal placeholder:text-white/30 focus:border-lime-400/60";
  const SEEK_STEP_SECONDS = 10;

  let musicClient: MusicClient | undefined;
  let open = $state(false);
  let status = $state<MusicSourceStatusResponse | undefined>(undefined);
  let statusLoading = $state(false);
  let statusError = $state(false);

  let title = $state("");
  let artist = $state("");
  let infoJson = $state("");
  let formError = $state<string | undefined>(undefined);

  /** 可点播的来源与音质选项来自音源脚本声明、经服务端白名单过滤后的能力。 */
  const sources = $derived(
    (status?.active?.sources ?? []).filter((entry) => entry.actions.includes("musicUrl")),
  );
  let selectedSource = $state("");
  let selectedQuality = $state("");
  const capability = $derived(sources.find((entry) => entry.source === selectedSource));

  const playbackTag = $derived(controller.musicState?._tag);
  const currentTrack = $derived.by(() => {
    const state = controller.musicState;
    return state?._tag === "loading" || state?._tag === "playing" || state?._tag === "paused"
      ? state.track
      : undefined;
  });
  const changedByName = $derived(controller.musicState?.changedBy?.nickname);

  /** 播放位置由服务端锚点推算，弹窗打开期间每 500ms 同步一次。 */
  let position = $state(0);

  onMount(() => {
    const handleOpen = (): void => {
      open = true;
    };
    window.addEventListener(OPEN_MUSIC_MANAGER_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_MUSIC_MANAGER_EVENT, handleOpen);
  });

  $effect(() => {
    if (!open || status !== undefined || statusLoading) return;
    void loadStatus();
  });

  $effect(() => {
    if (capability === undefined && sources.length > 0) selectedSource = sources[0].source;
  });

  $effect(() => {
    selectedQuality = capability?.qualitys[0] ?? "";
  });

  $effect(() => {
    if (!open) return;
    const state = controller.musicState;
    if (state?._tag === "paused") {
      position = state.positionSeconds;
      return;
    }
    if (state?._tag !== "playing") {
      position = 0;
      return;
    }
    position = controller.music.positionSeconds();
    const timer = setInterval(() => {
      position = controller.music.positionSeconds();
    }, 500);
    return () => clearInterval(timer);
  });

  async function loadStatus(): Promise<void> {
    statusLoading = true;
    statusError = false;
    try {
      musicClient ??= MusicClient.fromDescriptor(controller.descriptor);
      status = await musicClient.readStatus();
    } catch {
      statusError = true;
    } finally {
      statusLoading = false;
    }
  }

  function sourceName(platform: string): string {
    return sources.find((entry) => entry.source === platform)?.name ?? platform;
  }

  function stateLabel(state: MusicPlaybackState | undefined): string {
    switch (state?._tag) {
      case "playing":
        return "播放中";
      case "paused":
        return "已暂停";
      case "loading":
        return "解析中…";
      default:
        return "未播放";
    }
  }

  function formatPosition(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function togglePlayback(): void {
    if (playbackTag === "playing") controller.controlMusic(MusicPauseControl.make({}));
    else if (playbackTag === "paused") controller.controlMusic(MusicResumeControl.make({}));
  }

  function seekBy(deltaSeconds: number): void {
    controller.controlMusic(
      MusicSeekControl.make({
        positionSeconds: Math.min(86_400, Math.max(0, position + deltaSeconds)),
      }),
    );
  }

  function stopPlayback(): void {
    controller.controlMusic(MusicStopControl.make({}));
  }

  function playTrack(event: SubmitEvent): void {
    event.preventDefault();
    formError = undefined;
    const active = capability;
    if (active === undefined) {
      formError = "暂时没有可点播的音源";
      return;
    }
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      formError = "先填写歌曲名";
      return;
    }
    let musicInfo: unknown;
    try {
      musicInfo = JSON.parse(infoJson);
    } catch {
      formError = "歌曲信息不是有效的 JSON";
      return;
    }
    if (typeof musicInfo !== "object" || musicInfo === null || Array.isArray(musicInfo)) {
      formError = "歌曲信息需要是 JSON 对象";
      return;
    }
    controller.controlMusic(
      MusicPlayControl.make({
        source: active.source,
        title: trimmedTitle,
        artist: artist.trim(),
        info: selectedQuality ? { type: selectedQuality, musicInfo } : { musicInfo },
      }),
    );
    title = "";
    artist = "";
    infoJson = "";
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-night-950/70 backdrop-blur-sm" />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(92vw,22rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-panel-border bg-night-900 p-6 text-white shadow-2xl {pseudoLandscape.active ? 'dialog-pseudo' : ''}"
    >
      <div class="mb-5 flex items-center justify-between">
        <Dialog.Title class="flex items-center gap-2 text-lg font-black tracking-wide">
          <ListMusic size={19} class="text-lime-300" />
          共享音乐
        </Dialog.Title>
        <Dialog.Close class="cursor-pointer rounded-full p-1 text-white/60 transition hover:text-white">
          <X size={18} />
        </Dialog.Close>
      </div>

      <div class="rounded-2xl bg-white/5 p-4">
        {#if currentTrack}
          <div class="flex items-start gap-3">
            <span
              class="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full {playbackTag === 'playing'
                ? 'bg-lime-400/20 text-lime-300'
                : 'bg-white/10 text-white/60'}"
            >
              {#if playbackTag === "loading"}
                <LoaderCircle size={16} class="animate-spin" />
              {:else}
                <Music size={16} />
              {/if}
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-black text-white">{currentTrack.title}</p>
              <p class="truncate text-xs text-white/50">
                {currentTrack.artist || "未知艺术家"} · {sourceName(currentTrack.source)}
              </p>
              <p
                class="mt-1 text-xs font-bold {playbackTag === 'playing'
                  ? 'text-lime-300'
                  : 'text-white/50'}"
              >
                {stateLabel(controller.musicState)}
                {#if playbackTag === "playing" || playbackTag === "paused"}
                  · {formatPosition(position)}
                {/if}
                {#if changedByName}
                  · 由 {changedByName} 操作
                {/if}
              </p>
            </div>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            {#if playbackTag === "playing" || playbackTag === "paused"}
              <Button size="sm" onclick={togglePlayback}>
                {#if playbackTag === "playing"}
                  <Pause size={13} />
                  暂停
                {:else}
                  <Play size={13} />
                  继续
                {/if}
              </Button>
              <Button
                size="sm"
                aria-label="后退 {SEEK_STEP_SECONDS} 秒"
                onclick={() => seekBy(-SEEK_STEP_SECONDS)}
              >
                <Rewind size={13} />
                {SEEK_STEP_SECONDS}s
              </Button>
              <Button
                size="sm"
                aria-label="前进 {SEEK_STEP_SECONDS} 秒"
                onclick={() => seekBy(SEEK_STEP_SECONDS)}
              >
                <FastForward size={13} />
                {SEEK_STEP_SECONDS}s
              </Button>
            {/if}
            <Button size="sm" intent="danger" onclick={stopPlayback}>
              <Square size={13} />
              停止
            </Button>
          </div>
        {:else}
          <div class="flex items-center gap-2.5 text-white/50">
            <Music size={16} />
            <p class="text-xs font-bold">暂无播放，点一首歌和大家一起听</p>
          </div>
        {/if}
      </div>

      <div class="mt-5 border-t border-white/10 pt-5">
        <p class="mb-3 text-sm font-black text-white/85">点歌</p>

        {#if statusLoading}
          <p class="flex items-center gap-2 text-xs font-bold text-white/50">
            <LoaderCircle size={14} class="animate-spin" />
            正在读取音源…
          </p>
        {:else if statusError}
          <div class="flex items-center justify-between gap-3 rounded-xl bg-red-500/15 px-4 py-2.5">
            <p class="text-xs font-bold text-red-300">音源状态加载失败</p>
            <Button size="sm" onclick={() => void loadStatus()}>重试</Button>
          </div>
        {:else if status !== undefined && status.active === null}
          <p class="rounded-xl bg-white/5 px-4 py-2.5 text-xs font-bold text-white/50">
            服务器还没有配置音源，暂时无法点播
          </p>
        {:else if status?.active}
          {#if status.update}
            <p class="mb-3 rounded-xl bg-amber-400/10 px-4 py-2 text-xs font-bold text-amber-200">
              音源有新版本：{status.update.log}
            </p>
          {/if}
          <form class="flex flex-col gap-3" onsubmit={playTrack}>
            <div class="flex gap-3">
              <label class="min-w-0 flex-1">
                <span class="mb-1 block text-xs font-bold text-white/50">来源</span>
                <Select
                  bind:value={selectedSource}
                  options={sources.map((entry) => ({ value: entry.source, label: entry.name }))}
                  ariaLabel="来源"
                />
              </label>
              {#if capability !== undefined && capability.qualitys.length > 0}
                <label class="min-w-0 flex-1">
                  <span class="mb-1 block text-xs font-bold text-white/50">音质</span>
                  <Select
                    bind:value={selectedQuality}
                    options={capability.qualitys.map((quality) => ({ value: quality, label: quality }))}
                    ariaLabel="音质"
                  />
                </label>
              {/if}
            </div>
            <input
              bind:value={title}
              type="text"
              maxlength="128"
              placeholder="歌曲名"
              aria-label="歌曲名"
              class={INPUT_CLASS}
            />
            <input
              bind:value={artist}
              type="text"
              maxlength="128"
              placeholder="艺术家（可选）"
              aria-label="艺术家"
              class={INPUT_CLASS}
            />
            <textarea
              bind:value={infoJson}
              rows="3"
              aria-label="歌曲信息 JSON"
              placeholder={'歌曲信息 JSON，例如 {"songmid":"…","hash":"…"}'}
              class="{INPUT_CLASS} resize-none font-mono text-xs"
            ></textarea>
            {#if formError}
              <p class="rounded-xl bg-red-500/15 px-4 py-2 text-xs font-bold text-red-300">
                {formError}
              </p>
            {/if}
            <Button intent="primary" type="submit" class="w-full" disabled={sources.length === 0}>
              <Play size={14} />
              点播给大家听
            </Button>
          </form>
        {/if}
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
