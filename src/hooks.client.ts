import type { HandleClientError } from "@sveltejs/kit";

export const handleError: HandleClientError = ({ error, status, message }) => {
  console.error("Unhandled SvelteKit client error", { error, status, message });
  return {
    message: status === 404 ? "页面不存在" : "页面加载失败，请刷新后重试",
  };
};
