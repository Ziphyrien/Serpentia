<script lang="ts">
  import type { PageProps } from "./$types";
  import { goto, onNavigate } from "$app/navigation";
  import { onMount, untrack } from "svelte";
  import { installTouchFullscreen } from "$lib/client/fullscreen";
  import { SessionStore } from "$lib/client/stores/session.svelte";
  import { SettingsStore } from "$lib/client/stores/settings.svelte";
  import GameView from "$lib/components/game-view.svelte";

  let { data }: PageProps = $props();

  const session = new SessionStore(untrack(() => data.initialSessionState));
  const settings = new SettingsStore();

  onNavigate(({ to, willUnload }) => {
    const leavesGame = willUnload || to?.url.pathname !== "/game";
    if (leavesGame && session.state.status === "authenticated") {
      return session.endSession(willUnload);
    }
  });

  onMount(() => {
    const disposeFullscreen = installTouchFullscreen();
    const endSessionOnPageExit = (): void => {
      if (session.state.status === "authenticated") void session.endSession(true);
    };
    const returnHomeFromPageCache = (event: PageTransitionEvent): void => {
      if (event.persisted) void goto("/", { replaceState: true });
    };
    window.addEventListener("pagehide", endSessionOnPageExit);
    window.addEventListener("pageshow", returnHomeFromPageCache);
    return () => {
      window.removeEventListener("pagehide", endSessionOnPageExit);
      window.removeEventListener("pageshow", returnHomeFromPageCache);
      disposeFullscreen();
    };
  });

  async function retrySession(): Promise<void> {
    await session.bootstrap();
    if (session.state.status === "anonymous") {
      await goto("/", { replaceState: true });
    }
  }

  async function returnHome(): Promise<void> {
    await session.endSession();
    await goto("/", { replaceState: true });
  }

  function returnAfterExpiration(): void {
    session.markExpired();
    void goto("/", { replaceState: true });
  }
</script>

{#if session.state.status === "loading" || session.state.status === "anonymous"}
  <div
    class="game-map-background relative flex min-h-dvh items-center justify-center text-map-border"
  >
    <p class="animate-pulse rounded-full bg-white/85 px-6 py-2 text-sm font-black tracking-widest shadow-sm">
      正在进入蛇域…
    </p>
  </div>
{:else if session.state.status === "unavailable"}
  <div
    class="game-map-background relative flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-map-ink"
  >
    <p class="text-center text-base font-bold">{session.state.message}</p>
    <button
      class="rounded-full bg-linear-to-b from-[#ff7895] to-map-border px-8 py-2.5 font-black text-white shadow-[0_4px_0_#c83255,0_8px_20px_rgba(235,79,113,0.22)] transition active:translate-y-1 active:shadow-[0_1px_0_#c83255]"
      onclick={() => void retrySession()}
    >
      重试
    </button>
  </div>
{:else}
  <GameView
    session={session.state}
    {settings}
    onReturnHome={returnHome}
    onSessionExpired={returnAfterExpiration}
  />
{/if}
