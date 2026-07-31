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
  import Search from "lucide-svelte/icons/search";
  import Square from "lucide-svelte/icons/square";
  import X from "lucide-svelte/icons/x";
  import { OPEN_MUSIC_MANAGER_EVENT, type GameController } from "$lib/client/game.svelte";
  import { MusicClient, MusicClientError } from "$lib/client/net/music-client";
  import { pseudoLandscape } from "$lib/client/pseudo-landscape.svelte";
  import {
    MusicPauseControl,
    MusicPlayControl,
    MusicResumeControl,
    MusicSearchRequest,
    MusicSeekControl,
    MusicStopControl,
    type MusicPlaybackState,
    type MusicSearchTrack,
    type MusicSourcePlatform,
    type MusicSourceQuality,
    type MusicSourceStatusResponse,
  } from "$lib/protocol";
  import Button from "./ui/button.svelte";
  import Select from "./ui/select.svelte";

  let { controller }: { controller: GameController } = $props();

  const INPUT_CLASS =
    "w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-sm font-bold text-white outline-none transition placeholder:font-normal placeholder:text-white/30 focus:border-lime-400/60";
  const SEEK_STEP_SECONDS = 10;
  const SOURCE_NAMES: Readonly<Record<MusicSourcePlatform, string>> = {
    kw: "酷我",
    kg: "酷狗",
    tx: "QQ 音乐",
    wy: "网易云",
    mg: "咪咕",
    local: "本地",
  };

  let musicClient: MusicClient | undefined;
  let open = $state(false);
  let status = $state<MusicSourceStatusResponse | undefined>(undefined);
  let statusLoading = $state(false);
  let statusError = $state(false);

  let query = $state("");
  let searchResults = $state<Array<MusicSearchTrack>>([]);
  let searchLoading = $state(false);
  let searched = $state(false);
  let searchError = $state<string | undefined>(undefined);
  let searchAbort: AbortController | undefined;

  /** 仅展示当前音源脚本声明了 musicUrl 的在线来源。 */
  const sources = $derived(
    (status?.active?.sources ?? []).filter(
      (entry) => entry.source !== "local" && entry.actions.includes("musicUrl"),
    ),
  );
  let selectedSource = $state("");
  let selectedQuality = $state("");
  const capability = $derived(sources.find((entry) => entry.source === selectedSource));
  const sourceOptions = $derived(
    sources.map((entry) => ({ value: entry.source, label: sourceName(entry.source) })),
  );
  const qualityOptions = $derived(
    (capability?.qualitys ?? []).map((quality) => ({
      value: quality,
      label: qualityLabel(quality),
    })),
  );

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
    // 与首页 session bootstrap 一样提前加载；用户打开弹窗时通常已经有结果。
    void loadStatus();
    return () => {
      window.removeEventListener(OPEN_MUSIC_MANAGER_EVENT, handleOpen);
      searchAbort?.abort();
    };
  });

  $effect(() => {
    if (!open || status !== undefined || statusLoading || statusError) return;
    void loadStatus();
  });

  $effect(() => {
    if (capability === undefined && sources.length > 0) selectedSource = sources[0].source;
  });

  $effect(() => {
    const qualitys = capability?.qualitys ?? [];
    if (isMusicQuality(selectedQuality) && qualitys.includes(selectedQuality)) return;
    selectedQuality = qualitys.includes("320k") ? "320k" : (qualitys[0] ?? "");
  });

  $effect(() => {
    if (open) return;
    abortSearch();
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

  async function searchTracks(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const active = capability;
    const keywords = query.trim();
    searchError = undefined;
    if (active === undefined) {
      searchError = "暂时没有可搜索的音源";
      return;
    }
    if (keywords.length === 0) {
      searchError = "输入歌名或歌手后再搜索";
      return;
    }

    abortSearch();
    const requestAbort = new AbortController();
    searchAbort = requestAbort;
    // stale-while-revalidate：保留已有结果，避免搜索时列表跳成 loading 窗口。
    searchLoading = true;
    try {
      musicClient ??= MusicClient.fromDescriptor(controller.descriptor);
      const result = await musicClient.search(
        MusicSearchRequest.make({ source: active.source, query: keywords }),
        requestAbort.signal,
      );
      if (searchAbort !== requestAbort) return;
      searchResults = [...result.tracks];
      searched = true;
    } catch (cause) {
      if (requestAbort.signal.aborted || searchAbort !== requestAbort) return;
      searchError = musicSearchError(cause);
      searched = true;
    } finally {
      if (searchAbort === requestAbort) {
        searchAbort = undefined;
        searchLoading = false;
      }
    }
  }

  function resetSearch(): void {
    abortSearch();
    searchResults = [];
    searched = false;
    searchError = undefined;
  }

  function abortSearch(): void {
    searchAbort?.abort();
    searchAbort = undefined;
    searchLoading = false;
  }

  function playTrack(track: MusicSearchTrack): void {
    searchError = undefined;
    const quality = selectedMusicQuality();
    if (quality === undefined || !track.qualitys.includes(quality)) {
      searchError = "这首歌没有所选音质，请更换音质后再点播";
      return;
    }
    controller.controlMusic(
      MusicPlayControl.make({
        source: track.source,
        title: track.title,
        artist: track.artist,
        info: { type: quality, musicInfo: track.musicInfo },
      }),
    );
  }

  function canPlay(track: MusicSearchTrack): boolean {
    const quality = selectedMusicQuality();
    return quality !== undefined && track.qualitys.includes(quality);
  }

  function selectedMusicQuality(): MusicSourceQuality | undefined {
    return isMusicQuality(selectedQuality) ? selectedQuality : undefined;
  }

  function isMusicQuality(value: string): value is MusicSourceQuality {
    return value === "128k" || value === "320k" || value === "flac" || value === "flac24bit";
  }

  function sourceName(platform: MusicSourcePlatform): string {
    const configured = sources.find((entry) => entry.source === platform)?.name;
    return configured === undefined || configured === platform ? SOURCE_NAMES[platform] : configured;
  }

  function qualityLabel(quality: MusicSourceQuality): string {
    switch (quality) {
      case "128k":
        return "标准 128k";
      case "320k":
        return "高品 320k";
      case "flac":
        return "无损 FLAC";
      case "flac24bit":
        return "Hi-Res";
    }
  }

  function qualitySummary(track: MusicSearchTrack): string {
    return track.qualitys.map(qualityLabel).join(" · ");
  }

  function musicSearchError(cause: unknown): string {
    if (!(cause instanceof MusicClientError)) return "搜索失败，请稍后重试";
    switch (cause.code) {
      case "RATE_LIMITED":
        return "搜索太频繁，请稍后再试";
      case "TIMEOUT":
        return "音乐平台响应超时，请重试";
      case "UPSTREAM_FAILED":
      case "POLICY_DENIED":
        return "音乐平台搜索失败，请换个来源试试";
      case "SOURCE_UNAVAILABLE":
      case "INITIALIZATION_FAILED":
      case "RUNTIME_UNAVAILABLE":
        return "音源服务暂时不可用";
      case "UNAUTHORIZED":
        return "游戏会话已失效，请重新进入";
      case "INVALID_REQUEST":
        return "搜索条件无效，请修改后重试";
      default:
        return cause.stage === "transport" ? "网络连接失败，请重试" : "搜索结果解析失败";
    }
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

  function formatTrackDuration(seconds: number | null): string {
    return seconds === null ? "时长未知" : formatPosition(seconds);
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
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-night-950/70 backdrop-blur-sm" />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(94vw,25rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-panel-border bg-night-900 p-6 text-white shadow-2xl {pseudoLandscape.active ? 'dialog-pseudo' : ''}"
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
            <p class="text-xs font-bold">暂无播放，搜索一首歌和大家一起听</p>
          </div>
        {/if}
      </div>

      {#if controller.musicError}
        <p class="mt-3 rounded-xl bg-red-500/15 px-4 py-2 text-xs font-bold text-red-300" role="status">
          {controller.musicError}
        </p>
      {/if}

      <div class="mt-5 border-t border-white/10 pt-5">
        <p class="mb-3 text-sm font-black text-white/85">搜索点歌</p>

        {#if statusLoading}
          <p class="slow-pending flex items-center gap-2 text-xs font-bold text-white/50">
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
        {:else if status?.active && sources.length === 0}
          <p class="rounded-xl bg-white/5 px-4 py-2.5 text-xs font-bold text-white/50">
            当前音源没有可搜索的在线来源
          </p>
        {:else if status?.active}
          {#if status.update}
            <p class="mb-3 rounded-xl bg-amber-400/10 px-4 py-2 text-xs font-bold text-amber-200">
              音源有新版本：{status.update.log}
            </p>
          {/if}

          <form class="flex flex-col gap-3" aria-busy={searchLoading} onsubmit={searchTracks}>
            <div class="flex gap-3">
              <label class="min-w-0 flex-1">
                <span class="mb-1 block text-xs font-bold text-white/50">来源</span>
                <Select
                  bind:value={selectedSource}
                  options={sourceOptions}
                  ariaLabel="搜索来源"
                  onValueChange={resetSearch}
                />
              </label>
              <label class="min-w-0 flex-1">
                <span class="mb-1 block text-xs font-bold text-white/50">点播音质</span>
                <Select
                  bind:value={selectedQuality}
                  options={qualityOptions}
                  ariaLabel="点播音质"
                />
              </label>
            </div>

            <div class="flex gap-2">
              <label class="relative min-w-0 flex-1">
                <span class="sr-only">搜索歌曲</span>
                <Search
                  size={15}
                  class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-white/35"
                />
                <input
                  bind:value={query}
                  type="search"
                  maxlength="80"
                  autocomplete="off"
                  placeholder="歌名、歌手或专辑"
                  class="{INPUT_CLASS} pl-9"
                />
              </label>
              <Button
                intent="primary"
                type="submit"
                class="shrink-0"
                disabled={searchLoading || capability === undefined}
              >
                <Search size={14} />
                搜索
              </Button>
            </div>
          </form>

          <div class="mt-1 min-h-4 text-right">
            {#if searchLoading}
              <span class="slow-pending inline-flex items-center gap-1.5 text-[10px] font-bold text-white/40">
                <LoaderCircle size={11} class="animate-spin" />
                正在后台更新结果…
              </span>
            {/if}
          </div>

          {#if searchError}
            <p
              class="mt-3 rounded-xl bg-red-500/15 px-4 py-2 text-xs font-bold text-red-300"
              role="status"
            >
              {searchError}
            </p>
          {/if}

          {#if searchResults.length > 0}
            <div class="mt-4 flex max-h-64 flex-col gap-2 overflow-y-auto pr-1">
              {#each searchResults as track (track.id)}
                <div class="flex items-center gap-3 rounded-2xl bg-white/5 px-3 py-2.5">
                  <span
                    class="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/60"
                  >
                    <Music size={14} />
                  </span>
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-black text-white">{track.title}</p>
                    <p class="truncate text-xs text-white/50">
                      {track.artist || "未知艺术家"}{track.album ? ` · ${track.album}` : ""}
                    </p>
                    <p class="mt-0.5 truncate text-[10px] font-bold text-white/35">
                      {formatTrackDuration(track.durationSeconds)} · {qualitySummary(track)}
                    </p>
                  </div>
                  <Button
                    intent="primary"
                    size="sm"
                    class="shrink-0"
                    disabled={!canPlay(track)}
                    aria-label="点播 {track.title}"
                    onclick={() => playTrack(track)}
                  >
                    <Play size={13} />
                    点播
                  </Button>
                </div>
              {/each}
            </div>
          {:else if searched && !searchLoading}
            <p class="mt-4 rounded-2xl bg-white/5 px-4 py-5 text-center text-xs font-bold text-white/45">
              没找到相关歌曲，换个关键词或来源试试
            </p>
          {/if}
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
    width: min(94dvh, 25rem);
    max-height: calc(100dvw - 2rem);
    rotate: 90deg;
  }

  /*
   * 0.1-1s 的响应通常无需专门反馈；超过 0.9s 才渐显轻量状态。
   * 元素完成前被移除时动画从未出现，也不人为延迟真实结果。
   */
  .slow-pending {
    opacity: 0;
    animation: reveal-pending 140ms ease-out 900ms forwards;
  }

  @keyframes reveal-pending {
    to {
      opacity: 1;
    }
  }
</style>
