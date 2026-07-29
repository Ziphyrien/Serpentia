export type GameConnectionStatus = "connecting" | "online" | "reconnecting" | "closed";
export type GamePresentationPhase = "loading" | "ready" | "reconnecting" | "closed";

/** 首帧呈现前保持载入；呈现后，网络重连不会卸载已有 HUD。 */
export function gamePresentationPhase(
  connection: GameConnectionStatus,
  firstFramePresented: boolean,
): GamePresentationPhase {
  if (connection === "closed") return "closed";
  if (!firstFramePresented) return "loading";
  if (connection === "reconnecting") return "reconnecting";
  return "ready";
}
