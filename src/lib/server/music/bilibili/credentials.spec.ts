import { describe, expect, it } from "vite-plus/test";
import { BilibiliCredentials } from "./credentials";

describe("BilibiliCredentials", () => {
  it("accepts a raw server Cookie header and always redacts string serialization", () => {
    const credentials = BilibiliCredentials.fromEnvironment(
      "SESSDATA=fake-session; DedeUserID=100; bili_jct=fake-csrf",
    );
    expect(credentials.headerValue()).toContain("SESSDATA=fake-session");
    expect(String(credentials)).toBe("[REDACTED]");
    expect(JSON.stringify(credentials)).toBe('"[REDACTED]"');
  });

  it.each([
    "",
    "DedeUserID=100",
    "SESSDATA=",
    "SESSDATA=one; SESSDATA=two",
    "SESSDATA=one\nCookie: injected",
  ])("rejects an unsafe or unauthenticated value", (value) => {
    expect(() => BilibiliCredentials.fromEnvironment(value)).toThrow();
  });
});
