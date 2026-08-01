import type { MusicBackendErrorCode } from "$lib/protocol";

/** 音乐后端错误码对应的点播失败提示。 */
export function musicBackendErrorNotice(code: MusicBackendErrorCode): string {
  switch (code) {
    case "INVALID_REQUEST":
      return "点播请求无效，请重新搜索后再试";
    case "UNAUTHORIZED":
      return "游戏会话已失效，请重新进入";
    case "RATE_LIMITED":
      return "操作太频繁，请稍后再试";
    case "AUTH_REQUIRED":
      return "音乐账号登录已失效，暂时无法点播";
    case "RISK_CONTROLLED":
      return "触发了平台风控，请稍后再试";
    case "VIDEO_UNAVAILABLE":
      return "这个视频不存在或已下架，请换一首";
    case "AUDIO_UNAVAILABLE":
      return "这首歌没有所选音质，请更换音质或歌曲";
    case "UPSTREAM_FAILED":
      return "音乐平台响应失败，请重试";
    case "TIMEOUT":
      return "音乐平台响应超时，请重试";
    case "BACKEND_UNAVAILABLE":
      return "音乐服务暂时不可用，请稍后再试";
    case "POLICY_DENIED":
      return "音乐平台拒绝了这次点播，请换一首试试";
  }
}
