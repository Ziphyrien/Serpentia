import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { loadInitialSessionState } from "$lib/client/stores/session.svelte";

// Pixi、WebSocket、WebRTC 与输入系统只在真实游戏路由进入浏览器运行时。
export const ssr = false;

export const load: PageLoad = async ({ fetch }) => {
  const initialSessionState = await loadInitialSessionState(fetch);
  if (initialSessionState.status === "anonymous") redirect(307, "/");
  return { initialSessionState };
};
