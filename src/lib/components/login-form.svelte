<script lang="ts">
  import { ASSET_PATHS } from "$lib/client/config";
  import type { SessionStore } from "$lib/client/stores/session.svelte";

  let { session }: { session: SessionStore } = $props();

  let error = $state<string | undefined>(undefined);
  let submitting = $state(false);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    error = undefined;
    if (!session.savedNickname.trim()) {
      error = "先给自己起个名字吧";
      return;
    }
    submitting = true;
    const message = await session.login(session.savedNickname.trim());
    submitting = false;
    if (message) error = message;
  }
</script>

<div
  data-login-page
  class="relative flex h-dvh flex-col items-center justify-center overflow-hidden bg-night-950 px-6"
>
  <div
    class="absolute inset-0 bg-cover bg-center opacity-90"
    style="background-image: url({ASSET_PATHS.bgTile})"
  ></div>
  <div
    class="absolute inset-x-0 bottom-0 h-3/5 bg-cover bg-bottom opacity-60"
    style="background-image: url({ASSET_PATHS.loginHero}); mask-image: linear-gradient(to top, black 55%, transparent);"
  ></div>

  <div class="relative z-10 flex w-full max-w-sm flex-col items-center">
    <img src={ASSET_PATHS.logo} alt="蛇域" class="mb-2 w-64 drop-shadow-[0_10px_24px_rgba(0,0,0,0.55)] sm:w-80" />
    <p class="mb-8 text-sm font-medium tracking-widest text-white/70">和朋友一起的贪吃蛇战场</p>

    <form class="flex w-full flex-col gap-3" onsubmit={submit}>
      <input
        bind:value={session.savedNickname}
        type="text"
        maxlength="24"
        placeholder="你的昵称"
        class="h-13 w-full rounded-full border-2 border-white/15 bg-white/10 px-6 text-center text-lg font-bold text-white placeholder-white/45 backdrop-blur-sm outline-none transition focus:border-lime-300/70 focus:bg-white/15"
      />
      <button
        type="submit"
        disabled={submitting}
        class="mt-2 h-14 w-full rounded-full bg-linear-to-b from-lime-300 to-lime-500 text-xl font-black tracking-widest text-night-950 shadow-[0_6px_0_#3f7a1d,0_12px_24px_rgba(0,0,0,0.4)] transition active:translate-y-1 active:shadow-[0_2px_0_#3f7a1d] disabled:opacity-60"
      >
        {submitting ? "进入中…" : "进入蛇域"}
      </button>
    </form>

    {#if error}
      <p class="mt-4 rounded-full bg-red-500/85 px-5 py-1.5 text-sm font-bold text-white shadow-lg">{error}</p>
    {/if}

  </div>
</div>
