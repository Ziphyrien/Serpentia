<script lang="ts">
  import Play from "lucide-svelte/icons/play";
  import type { MusicSearchTrack } from "$lib/protocol";
  import Button from "./ui/button.svelte";

  let {
    track,
    current,
    disabled,
    onPlay,
  }: {
    track: MusicSearchTrack;
    /** 是否为当前正在播放/暂停的曲目 */
    current: boolean;
    /** 后端不可用，禁止点播 */
    disabled: boolean;
    onPlay: (track: MusicSearchTrack) => void;
  } = $props();

  // 封面加载完成后淡入；占位尺寸固定，布局不因图片加载而位移
  let coverLoaded = $state(false);

  const durationText = $derived(formatDuration(track.durationSeconds));

  function formatDuration(seconds: number | null): string {
    if (seconds === null) return "";
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
  }
</script>

<div class="flex h-12 touch-manipulation items-center gap-2.5">
  <div class="relative size-10 shrink-0 overflow-hidden rounded-lg bg-white/10">
    {#if track.pictureUrl !== null}
      <img
        src={track.pictureUrl}
        alt=""
        referrerpolicy="no-referrer"
        draggable="false"
        class="size-full object-cover transition-opacity duration-300 {coverLoaded
          ? 'opacity-100'
          : 'opacity-0'}"
        onload={() => (coverLoaded = true)}
      />
    {/if}
    {#if current}
      <span
        class="absolute inset-x-0 bottom-0 bg-lime-400/90 py-0.5 text-center text-[9px] font-black leading-none text-night-950"
      >
        当前
      </span>
    {/if}
  </div>
  <div class="min-w-0 flex-1">
    <p class="truncate text-sm font-black text-white">{track.title}</p>
    <p class="truncate text-xs text-white/50">
      {track.artist || "未知艺术家"}{durationText === "" ? "" : ` · ${durationText}`}
    </p>
  </div>
  <!-- 点播反馈由顶部播放卡片（延迟加载动画）承担，按钮本身不体现加载状态 -->
  <Button intent="primary" size="sm" class="shrink-0" {disabled} onclick={() => onPlay(track)}>
    <Play size={13} />
    点播
  </Button>
</div>
