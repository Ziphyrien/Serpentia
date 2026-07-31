import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { MusicSourceError } from "./errors";
import { parseMusicSourceScript } from "./metadata";

const script = `/*!
 * @name Example
 * @description Description
 * @version 4
 * @author Author
 * @repository https://example.test/repository
 */
globalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, { sources: {} })`;

describe("LX music source metadata", () => {
  it("parses a leading LX block and accepts repository as homepage", () => {
    const parsed = parseMusicSourceScript(script);

    expect(parsed.metadata).toMatchObject({
      name: "Example",
      description: "Description",
      version: "4",
      author: "Author",
      homepage: "https://example.test/repository",
    });
    expect(parsed.metadata.digest).toBe(createHash("sha256").update(script).digest("hex"));
    expect(parsed.script).toBe(script);
  });

  it("uses homepage before repository and applies LX metadata limits", () => {
    const parsed = parseMusicSourceScript(`/*!
 * @name ${"n".repeat(30)}
 * @homepage https://example.test/home
 * @repository https://example.test/repository
 */`);

    expect(parsed.metadata.name).toBe(`${"n".repeat(24)}...`);
    expect(parsed.metadata.homepage).toBe("https://example.test/home");
  });

  it("rejects files without a leading metadata block", () => {
    expect(() => parseMusicSourceScript("globalThis.lx.send('inited', {})")).toThrow(
      MusicSourceError,
    );
  });

  it("rejects scripts above the configured UTF-8 byte limit", () => {
    expect(() => parseMusicSourceScript(`/* @name Large */${"界".repeat(180_000)}`)).toThrow(
      MusicSourceError,
    );
  });
});
