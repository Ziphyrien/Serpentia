import { describe, expect, it } from "vite-plus/test";
import { gamePresentationPhase } from "./game-readiness";

describe("game presentation readiness", () => {
  it("keeps initial connection and renderer setup behind the loading phase", () => {
    expect(gamePresentationPhase("connecting", false)).toBe("loading");
    expect(gamePresentationPhase("online", false)).toBe("loading");
  });

  it("reveals the game only after an authoritative frame was presented", () => {
    expect(gamePresentationPhase("online", true)).toBe("ready");
  });

  it("keeps the presented HUD available while reconnecting", () => {
    expect(gamePresentationPhase("reconnecting", true)).toBe("reconnecting");
  });

  it("gives the terminal state precedence over prior readiness", () => {
    expect(gamePresentationPhase("closed", false)).toBe("closed");
    expect(gamePresentationPhase("closed", true)).toBe("closed");
  });
});
