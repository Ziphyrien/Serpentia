<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Dialog } from "bits-ui";
  import X from "lucide-svelte/icons/x";
  import Search from "lucide-svelte/icons/search";
  import Play from "lucide-svelte/icons/play";
  import Pause from "lucide-svelte/icons/pause";
  import Rewind from "lucide-svelte/icons/rewind";
  import FastForward from "lucide-svelte/icons/fast-forward";
  import Square from "lucide-svelte/icons/square";
  import Music2 from "lucide-svelte/icons/music-2";
  import LoaderCircle from "lucide-svelte/icons/loader-circle";
  import { pseudoLandscape } from "$lib/client/pseudo-landscape.svelte";
  import { OPEN_MUSIC_MANAGER_EVENT, type GameController } from "$lib/client/game.svelte";
  import { DeferredIndicator, type MusicLibrary } from "$lib/client/net/music-library.svelte";
  import { expectedPosition } from "$lib/client/audio/music";
  import type { MusicSearchTrack } from "$lib/protocol";
  import MusicTrackRow from "./music-track-row.svelte";
  import Button from "./ui/button.svelte";

  let { controller, library }: { controller: GameController; library: MusicLibrary } = $props();

  let open = $state(false);
  const SEEK_STEP_SECONDS = 10;
  const SEARCH_ROW_STRIDE_PX = 52;

  let query = $state("");
  let visibleTrackCount = $state(0);
  /**
   * 卡片加载动画与搜索骨架共用同一套「自适应延迟 + 最短停留」方案：
   * 加载在延迟窗口内完成则动画从不出现，一旦出现至少停留 300ms。
   * 延迟沿用搜索请求的滑动延迟估计（同一后端，响应能力一致）；
   * 延迟窗口内卡片冻结在最近一个非加载态，避免内容闪烁。
   */
  const loadingIndicator = new DeferredIndicator();
  let stablePlayback = $state<PlaybackView | undefined>(undefined);

  onMount(() => {
    const openManager = (): void => {
      open = true;
    };
    window.addEventListener(OPEN_MUSIC_MANAGER_EVENT, openManager);
    return () => window.removeEventListener(OPEN_MUSIC_MANAGER_EVENT, openManager);
  });

  $effect(() => {
    const active = open;
    untrack(() => {
      controller.setMenuOpen("music", active);
      if (active) library.ensureStatus();
    });
    return () => {
      if (active) untrack(() => controller.setMenuOpen("music", false));
    };
  });

  // loading 期间臂起延迟指示；离开 loading 即按最短停留规则收起
  $effect(() => {
    if (controller.musicState?._tag === "loading") {
      loadingIndicator.arm(library.latency.indicatorDelayMs);
    } else {
      untrack(() => loadingIndicator.disarm());
    }
  });

  // 播放中每 500ms 按服务器时钟重算进度
  let clockNow = $state(0);
  $effect(() => {
    if (!open || controller.musicState?._tag !== "playing") return;
    const update = (): void => {
      clockNow = controller.clockSync.serverNow() ?? Date.now();
    };
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  });

  type PlaybackView = ReturnType<typeof computePlayback>;

  function computePlayback() {
    const state = controller.musicState;
    if (state === undefined || state._tag === "stopped") return { tag: "idle" as const };
    if (state._tag === "loading") {
      return { tag: "loading" as const, by: state.changedBy.nickname };
    }
    const position =
      state._tag === "playing"
        ? expectedPosition(state, clockNow === 0 ? state.anchorServerTime : clockNow)
        : state.positionSeconds;
    return {
      tag: state._tag,
      track: state.track,
      by: state.changedBy.nickname,
      position,
      duration: state.track.durationSeconds,
    };
  }

  const rawPlayback = $derived.by(computePlayback);

  // 记录最近一个非加载态视图，供加载延迟窗口内冻结展示
  $effect(() => {
    const view = rawPlayback;
    if (view.tag !== "loading") stablePlayback = view;
  });

  const playback = $derived<PlaybackView>(
    rawPlayback.tag === "loading" && !loadingIndicator.visible && stablePlayback !== undefined
      ? stablePlayback
      : rawPlayback,
  );

  const currentBvid = $derived(
    playback.tag === "playing" || playback.tag === "paused" ? playback.track.bvid : undefined,
  );
  const backendDown = $derived(library.status !== undefined && !library.status.available);
  const errorNotice = $derived.by(() => {
    if (controller.musicError !== undefined) {
      return { tag: "music" as const, message: controller.musicError };
    }
    if (library.statusFailed && library.status === undefined) {
      return { tag: "status" as const, message: "音乐服务状态获取失败" };
    }
    if (backendDown) {
      return { tag: "backend" as const, message: "音乐服务暂时不可用，请稍后再试" };
    }
    if (library.searchError !== undefined) {
      return { tag: "search" as const, message: library.searchError };
    }
    return undefined;
  });
  const progressPercent = $derived(
    playback.tag === "playing" || playback.tag === "paused"
      ? playback.duration !== null && playback.duration > 0
        ? Math.min(100, (playback.position / playback.duration) * 100)
        : 0
      : 0,
  );
  const progressText = $derived(
    playback.tag === "playing" || playback.tag === "paused"
      ? playback.duration !== null
        ? `${formatClock(playback.position)} / ${formatClock(playback.duration)}`
        : formatClock(playback.position)
      : "",
  );

  function formatClock(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
  }

  $effect(() => {
    void library.tracks.length;
    library.loadMoreWhenVisible(visibleTrackCount);
  });

  function updateVisibleTrackCount(event: Event): void {
    const list = event.currentTarget;
    if (!(list instanceof HTMLElement)) return;
    visibleTrackCount = Math.ceil((list.scrollTop + list.clientHeight) / SEARCH_ROW_STRIDE_PX);
    library.loadMoreWhenVisible(visibleTrackCount);
  }

  function playTrack(track: MusicSearchTrack): void {
    const quality = track.qualities.at(-1);
    if (quality === undefined) return;
    controller.sfx.click();
    controller.controlMusic({ _tag: "play", reference: track.reference, quality });
  }

  function seekBy(deltaSeconds: number): void {
    if (playback.tag !== "playing" && playback.tag !== "paused") return;
    controller.sfx.click();
    controller.controlMusic({
      _tag: "seek",
      positionSeconds: Math.min(86_400, Math.max(0, Math.round(playback.position + deltaSeconds))),
    });
  }

  function seek(event: MouseEvent): void {
    const state = controller.musicState;
    if (state?._tag !== "playing" && state?._tag !== "paused") return;
    const duration = state.track.durationSeconds;
    if (duration === null || duration <= 0) return;
    const bar = event.currentTarget;
    if (!(bar instanceof HTMLElement)) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    controller.controlMusic({ _tag: "seek", positionSeconds: Math.round(ratio * duration) });
  }

  function togglePlayback(): void {
    if (playback.tag !== "playing" && playback.tag !== "paused") return;
    controller.sfx.click();
    controller.controlMusic({ _tag: playback.tag === "playing" ? "pause" : "resume" });
  }

  function stopPlayback(): void {
    controller.sfx.click();
    controller.controlMusic({ _tag: "stop" });
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-night-950/70 backdrop-blur-sm" />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(92vw,24rem)] -translate-x-1/2 -translate-y-1/2 sm:w-[min(92vw,40rem)] overflow-y-auto rounded-3xl border border-panel-border bg-night-900 p-5 text-white shadow-2xl {pseudoLandscape.active
        ? 'music-dialog-pseudo'
        : ''}"
    >
      <div class="mb-4 flex items-center justify-between">
        <Dialog.Title class="text-lg font-black tracking-wide">管理音乐</Dialog.Title>
        <Dialog.Close
          class="cursor-pointer rounded-full p-1 text-white/60 transition hover:text-white"
        >
          <X size={18} />
        </Dialog.Close>
      </div>

      <!-- 宽屏左右结构：卡片+搜索一侧，状态条+结果列表另一侧；窄屏纵向堆叠 -->
      <div class="flex flex-col gap-4 sm:flex-row">
        <div class="flex min-w-0 flex-1 flex-col gap-4">
          <!-- 当前播放区：结构固定，播放状态切换不改变高度 -->
          <section class="rounded-2xl bg-white/5 px-3.5 py-3">
        <div class="flex h-12 items-center gap-3">
          {#if playback.tag === "idle"}
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white/50"
            >
              <Music2 size={18} />
            </span>
            <div class="min-w-0 flex-1">
              <p class="text-[13px] font-black text-white/85">还没有人点歌</p>
              <p class="text-[11px] text-white/45">搜到喜欢的歌，抢先点播</p>
            </div>
          {:else if playback.tag === "loading"}
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/10 text-lime-300"
            >
              <LoaderCircle size={18} class="animate-spin" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="text-[13px] font-black text-white/85">正在加载音乐…</p>
              <p class="truncate text-[11px] text-white/45">{playback.by} 点播</p>
            </div>
          {:else}
            <div class="relative size-10 shrink-0 overflow-hidden rounded-lg bg-white/10">
              {#if playback.track.pictureUrl !== null}
                <img
                  src={playback.track.pictureUrl}
                  alt=""
                  referrerpolicy="no-referrer"
                  draggable="false"
                  class="size-full object-cover"
                />
              {/if}
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px] font-black text-white">{playback.track.title}</p>
              <p class="truncate text-[11px] text-white/45">
                {playback.track.artist || "未知艺术家"} · {playback.by} 点播
              </p>
            </div>
          {/if}
        </div>
        <!-- 控制按钮：点播前也展示真实控件，仅按播放状态启用 -->
        <div class="mt-3 grid h-8 grid-cols-4 items-center gap-1.5">
          <Button
            size="sm"
            class="w-full px-2!"
            disabled={playback.tag !== "playing" && playback.tag !== "paused"}
            onclick={togglePlayback}
          >
            {#if playback.tag === "playing"}
              <Pause size={13} />
              暂停
            {:else if playback.tag === "paused"}
              <Play size={13} />
              继续
            {:else}
              <Play size={13} />
              播放
            {/if}
          </Button>
          <Button
            size="sm"
            class="w-full px-2!"
            aria-label="后退 {SEEK_STEP_SECONDS} 秒"
            disabled={playback.tag !== "playing" && playback.tag !== "paused"}
            onclick={() => seekBy(-SEEK_STEP_SECONDS)}
          >
            <Rewind size={13} />
            {SEEK_STEP_SECONDS}s
          </Button>
          <Button
            size="sm"
            class="w-full px-2!"
            aria-label="前进 {SEEK_STEP_SECONDS} 秒"
            disabled={playback.tag !== "playing" && playback.tag !== "paused"}
            onclick={() => seekBy(SEEK_STEP_SECONDS)}
          >
            <FastForward size={13} />
            {SEEK_STEP_SECONDS}s
          </Button>
          <Button
            size="sm"
            intent="danger"
            class="w-full px-2!"
            disabled={playback.tag === "idle"}
            onclick={stopPlayback}
          >
            <Square size={13} />
            停止
          </Button>
        </div>
        <!-- 真实进度控件仅桌面端显示；空闲/加载状态保持 0:00 并禁用 -->
        <div class="music-progress-row mt-2 flex h-8 items-center gap-2.5">
          <button
            class="group flex h-8 flex-1 cursor-pointer items-center disabled:cursor-default"
            aria-label="调整播放进度"
            disabled={playback.tag !== "playing" && playback.tag !== "paused"}
            onclick={seek}
          >
            <span class="relative h-1.5 w-full rounded-full bg-white/15">
              <span
                class="absolute inset-y-0 left-0 rounded-full bg-lime-400 transition-[width] duration-500 ease-linear"
                style:width="{progressPercent}%"
              ></span>
            </span>
          </button>
          <span class="shrink-0 text-[11px] font-bold text-white/45 tabular-nums">
            {progressText || "0:00"}
          </span>
        </div>
      </section>

          <form
            class="flex gap-2"
        onsubmit={(event) => {
          event.preventDefault();
          if (!library.firstPageLoading) library.searchNow(query);
        }}
      >
        <input
          type="search"
          enterkeyhint="search"
          autocomplete="off"
          aria-label="搜索歌名或歌手"
          value={query}
          disabled={backendDown}
          placeholder={backendDown ? "音乐服务暂不可用" : "搜索歌名或歌手"}
          class="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-sm font-bold text-white outline-none transition placeholder:font-normal placeholder:text-white/30 focus:border-lime-400/60 disabled:opacity-50"
          oninput={(event) => {
            query = event.currentTarget.value;
            if (query.trim() === "") library.requestSearch("");
          }}
        />
        <!-- 显式提交按钮：移动端虚拟键盘的回车不一定会触发表单提交 -->
        <Button
          intent="primary"
          size="sm"
          type="submit"
          aria-label="搜索"
          class="shrink-0 touch-manipulation"
          disabled={backendDown || query.trim() === "" || library.firstPageLoading}
        >
          <Search size={13} />
          搜索
        </Button>
          </form>

          <!-- 左列剩余空间统一承载单条紧凑错误，不挤占列表或弹窗顶部 -->
          <div class="min-h-0 min-w-0 flex-1" aria-live="polite">
            {#if errorNotice !== undefined}
              <div
                class="flex h-8 max-w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg px-3 text-[11px] leading-4 font-bold {errorNotice.tag === 'backend'
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-red-500/20 text-red-300'}"
              >
                <span class="min-w-0 flex-1 truncate">
                  {errorNotice.message}
                </span>
                {#if errorNotice.tag === "status"}
                  <button class="shrink-0 cursor-pointer text-lime-300 underline" onclick={() => library.retryStatus()}>
                    重试
                  </button>
                {:else if errorNotice.tag === "search"}
                  <button class="shrink-0 cursor-pointer text-lime-300 underline" onclick={() => library.retry()}>
                    重试
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        </div>

        <div class="min-w-0 flex-1">
          <!-- 列表容器高度固定 + scrollbar-gutter，任何状态切换都不引起布局位移 -->
          <div
            class="h-64 overflow-y-auto pr-1 scrollbar-gutter-stable"
            onscroll={updateVisibleTrackCount}
          >
        {#if library.showSkeleton && library.tracks.length === 0}
          <div class="flex flex-col gap-1">
            {#each Array.from({ length: 5 }) as _, index (index)}
              <div class="flex h-12 animate-pulse items-center gap-2.5">
                <div class="size-10 shrink-0 rounded-lg bg-white/10"></div>
                <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div class="h-2.5 w-3/5 rounded-full bg-white/10"></div>
                  <div class="h-2 w-2/5 rounded-full bg-white/5"></div>
                </div>
                <div class="h-6 w-14 shrink-0 rounded-full bg-white/10"></div>
              </div>
            {/each}
          </div>
        {:else if library.tracks.length > 0}
          <div class="flex flex-col gap-1">
            {#each library.tracks as track (track.bvid)}
              <MusicTrackRow
                {track}
                current={currentBvid === track.bvid}
                disabled={backendDown}
                onPlay={playTrack}
              />
            {/each}
            {#if library.moreSkeletonCount > 0}
              <div class="flex animate-pulse flex-col gap-1">
                {#each Array.from({ length: library.moreSkeletonCount }) as _, index (index)}
                  <div class="flex h-12 items-center gap-2.5">
                    <div class="size-10 shrink-0 rounded-lg bg-white/10"></div>
                    <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                      <div class="h-2.5 w-3/5 rounded-full bg-white/10"></div>
                      <div class="h-2 w-2/5 rounded-full bg-white/5"></div>
                    </div>
                    <div class="h-6 w-14 shrink-0 rounded-full bg-white/10"></div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {:else if library.searching}
          <!-- 自适应延迟窗口内：响应大概率马上到达，保持空白避免任何闪烁 -->
          <div class="h-full"></div>
        {:else if library.searchError === undefined && library.resultQuery !== ""}
          <div class="flex h-full items-center justify-center">
            <p class="text-sm font-bold text-white/50">没有找到「{library.resultQuery}」相关的歌曲</p>
          </div>
        {:else}
          <!-- 搜索前：尺寸和位置严格对齐真实列表行，静态显示以区别加载骨架 -->
          <div class="flex flex-col gap-1 opacity-50">
            {#each Array.from({ length: 5 }) as _, index (index)}
              <div class="flex h-12 items-center gap-2.5">
                <div class="size-10 shrink-0 rounded-lg bg-white/10"></div>
                <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div class="h-2.5 w-3/5 rounded-full bg-white/10"></div>
                  <div class="h-2 w-2/5 rounded-full bg-white/5"></div>
                </div>
                <div class="h-6 w-14 shrink-0 rounded-full bg-white/10"></div>
              </div>
            {/each}
          </div>
        {/if}
          </div>
        </div>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  @media (hover: none), (pointer: coarse) {
    .music-progress-row {
      display: none;
    }
  }

  /*
   * 伪横屏：弹框 Portal 到 body，不在旋转容器内，需自行顺时针旋转 90°，
   * 宽高约束换成旋转后的画面尺寸（画面宽 = 100dvh，画面高 = 100dvw）。
   */
  /* class 应用在 bits-ui 组件上，Svelte 无法静态识别，需 :global 防止裁剪 */
  :global(.music-dialog-pseudo) {
    width: min(92dvh, 24rem);
    max-height: calc(100dvw - 2rem);
    rotate: 90deg;
  }
</style>
