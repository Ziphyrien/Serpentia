<script lang="ts">
  import { internalSkinOrDefault } from "$lib/game/internal-skins";
  import { pseudoLandscape } from "$lib/client/pseudo-landscape.svelte";
  import type { SessionStore } from "$lib/client/stores/session.svelte";
  import SkinPicker from "./skin-picker.svelte";
  import SnakeSkinPreview from "./snake-skin-preview.svelte";
  import MovingStarDecoration from "./moving-star-decoration.svelte";

  let {
    session,
    onAuthenticated,
  }: {
    session: SessionStore;
    onAuthenticated?: () => void | Promise<void>;
  } = $props();

  const TOP_DOTS = [
    { path: "/assets/art/food/dot-1.png", left: "7%", top: "5%", size: 15 },
    { path: "/assets/art/food/dot-2.png", left: "19%", top: "11%", size: 12 },
    { path: "/assets/art/food/dot-3.png", left: "32%", top: "4%", size: 18 },
    { path: "/assets/art/food/dot-4.png", left: "46%", top: "12%", size: 13 },
    { path: "/assets/art/food/dot-5.png", left: "60%", top: "6%", size: 16 },
    { path: "/assets/art/food/dot-6.png", left: "73%", top: "11%", size: 19 },
    { path: "/assets/art/food/dot-7.png", left: "84%", top: "4%", size: 13 },
  ];

  let error = $state<string | undefined>(undefined);
  let submitting = $state(false);
  let skinPickerOpen = $state(false);
  let selectedSkin = $derived(internalSkinOrDefault(session.savedSkinId));

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    error = undefined;
    const nickname = session.savedNickname.trim();
    if (!nickname) {
      error = "先给自己起个名字吧";
      return;
    }
    submitting = true;
    const message = await session.login(nickname, session.savedSkinId);
    submitting = false;
    if (message) {
      error = message;
      return;
    }
    if (session.state.status === "authenticated") await onAuthenticated?.();
  }
</script>

{#if skinPickerOpen}
  <SkinPicker
    selectedSkinId={session.savedSkinId}
    onSelect={(skinId) => (session.savedSkinId = skinId)}
    onClose={() => (skinPickerOpen = false)}
  />
{/if}

<div
  data-login-page
  class="game-map-background relative {pseudoLandscape.active ? 'h-full' : 'h-dvh'} overflow-y-auto px-5 py-8 text-map-ink @md:overflow-hidden @md:px-8"
>
  <div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
    {#each TOP_DOTS as dot (dot.path)}
      <img
        src={dot.path}
        alt=""
        draggable="false"
        width={dot.size}
        height={dot.size}
        style:left={dot.left}
        style:top={dot.top}
        class="absolute select-none"
      />
    {/each}
    <MovingStarDecoration />
    <img
      src="/assets/art/wrecks/candy-12.png"
      alt=""
      draggable="false"
      class="absolute right-[2%] bottom-[4%] size-16 -rotate-12 select-none @sm:right-[5%] @sm:size-20 @md:top-1/2 @md:right-[8%] @md:bottom-auto @md:size-28 @md:-translate-y-1/2"
    />
  </div>

  <div
    class="relative z-10 mx-auto grid min-h-full w-full max-w-6xl grid-cols-1 items-center gap-6 @md:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)_minmax(0,1fr)] @md:gap-8"
  >
    <section class="order-2 flex min-w-0 flex-col items-center justify-center @md:order-1 @md:items-end">
      <div class="flex w-80 max-w-full flex-col items-center">
        <div class="relative aspect-video w-80 max-w-full" data-ui>
          <SnakeSkinPreview skin={selectedSkin} width={320} height={180} animated />
        </div>
        <button
          type="button"
          onclick={() => (skinPickerOpen = true)}
          class="mt-1 h-12 rounded-full border-2 border-map-border bg-white/90 px-8 text-sm font-black tracking-widest text-map-border shadow-[0_4px_0_#c83255] backdrop-blur-sm transition active:translate-y-1 active:shadow-none"
        >
          选择皮肤
        </button>
      </div>
    </section>

    <main class="order-1 flex w-full flex-col items-center @md:order-2">
      <h1 class="mb-8 text-6xl font-black tracking-[0.18em] text-map-border drop-shadow-[0_4px_0_rgba(255,255,255,0.9)] @sm:text-7xl">
        蛇域
      </h1>

      <form class="flex w-full flex-col gap-3" onsubmit={submit}>
        <input
          bind:value={session.savedNickname}
          aria-label="昵称"
          type="text"
          maxlength="24"
          placeholder="你的昵称"
          class="h-13 w-full rounded-full border-2 border-map-grid bg-white/90 px-6 text-center text-lg font-bold text-map-ink shadow-[0_8px_24px_rgba(85,88,106,0.1)] backdrop-blur-sm outline-none transition placeholder:text-map-ink/40 focus:border-map-border focus:bg-white"
        />
        <button
          type="submit"
          disabled={submitting}
          class="mt-2 h-14 w-full rounded-full bg-map-border text-xl font-black tracking-widest text-white shadow-[0_6px_0_#c83255,0_12px_24px_rgba(235,79,113,0.24)] transition active:translate-y-1 active:shadow-[0_2px_0_#c83255] disabled:opacity-60"
        >
          {submitting ? "加入中…" : "加入游戏"}
        </button>
      </form>

      {#if error}
        <p class="mt-4 rounded-full bg-red-500/90 px-5 py-1.5 text-sm font-bold text-white shadow-lg">
          {error}
        </p>
      {/if}
    </main>

    <div class="order-3 hidden @md:block" aria-hidden="true"></div>
  </div>
</div>
