/** 用户可见的终止连接原因；不直接展示服务端 WebSocket reason。 */
export function terminalGameCloseNotice(code: number): string | undefined {
  if (code === 4001) return "当前游戏会话已在其他窗口打开";
  if (code === 4409) return "昵称已被占用，请更换昵称";
  return undefined;
}
