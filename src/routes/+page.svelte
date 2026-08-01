<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { installTouchFullscreen } from "$lib/client/fullscreen";
  import { pseudoLandscape } from "$lib/client/pseudo-landscape.svelte";
  import { SessionStore } from "$lib/client/stores/session.svelte";
  import LoginForm from "$lib/components/login-form.svelte";
  import PseudoLandscapeShell from "$lib/components/pseudo-landscape-shell.svelte";

  const session = new SessionStore({ status: "anonymous", descriptor: undefined });

  async function bootstrapHome(): Promise<void> {
    await session.bootstrap();
    // 首页始终是显式入口：清理残留 Cookie 会话，不自动恢复并跳转到 /game。
    if (session.state.status === "authenticated") await session.endSession();
  }

  onMount(() => {
    const disposeFullscreen = installTouchFullscreen();
    void bootstrapHome();
    return disposeFullscreen;
  });
</script>

<PseudoLandscapeShell>
{#if session.state.status === "unavailable"}
  <div
    data-login-page
    class="game-map-background relative flex {pseudoLandscape.active ? 'h-full' : 'min-h-dvh'} flex-col items-center justify-center gap-4 px-6 text-map-ink"
  >
    <p class="text-center text-base font-bold">{session.state.message}</p>
    <button
      class="rounded-full bg-linear-to-b from-[#ff7895] to-map-border px-8 py-2.5 font-black text-white shadow-[0_4px_0_#c83255,0_8px_20px_rgba(235,79,113,0.22)] transition active:translate-y-1 active:shadow-[0_1px_0_#c83255]"
      onclick={() => void bootstrapHome()}
    >
      重试
    </button>
  </div>
{:else}
  <LoginForm {session} onAuthenticated={() => goto("/game")} />
{/if}
</PseudoLandscapeShell>
