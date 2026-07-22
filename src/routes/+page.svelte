<script lang="ts">
  import { onMount } from "svelte";
  import { SessionStore } from "$lib/client/stores/session.svelte";
  import { SettingsStore } from "$lib/client/stores/settings.svelte";
  import LoginForm from "$lib/components/login-form.svelte";
  import GameView from "$lib/components/game-view.svelte";

  const session = new SessionStore();
  const settings = new SettingsStore();

  onMount(() => {
    void session.bootstrap();
  });
</script>

{#if session.state.status === "loading"}
  <div class="flex min-h-dvh items-center justify-center bg-night-950">
    <p class="animate-pulse text-sm font-bold tracking-widest text-white/50">正在进入蛇域…</p>
  </div>
{:else if session.state.status === "unavailable"}
  <div class="flex min-h-dvh flex-col items-center justify-center gap-4 bg-night-950 px-6">
    <p class="text-center text-base font-bold text-white/85">{session.state.message}</p>
    <button
      class="rounded-full bg-lime-400 px-8 py-2.5 font-black text-night-950 transition active:scale-95"
      onclick={() => void session.bootstrap()}
    >
      重试
    </button>
  </div>
{:else if session.state.status === "anonymous"}
  <LoginForm {session} />
{:else}
  <GameView session={session.state} {settings} sessionStore={session} />
{/if}
