import { describe, expect, it } from "vite-plus/test";
import { terminalGameCloseNotice } from "./game-close-notice";

describe("terminal game close notices", () => {
  it("localizes a duplicate nickname without using the server close reason", () => {
    expect(terminalGameCloseNotice(4409)).toBe("昵称已被占用，请更换昵称");
  });

  it("keeps the duplicate-session close notice localized", () => {
    expect(terminalGameCloseNotice(4001)).toBe("当前游戏会话已在其他窗口打开");
  });

  it("leaves reconnectable close codes unmapped", () => {
    expect(terminalGameCloseNotice(1006)).toBeUndefined();
  });
});
