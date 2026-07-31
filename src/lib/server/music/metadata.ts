import { createHash } from "node:crypto";
import { MusicSourceMetadata } from "../../protocol";
import { musicSourceError } from "./errors";

const MAX_SCRIPT_BYTES = 524_288;
const INFO_LIMITS = {
  name: 24,
  description: 36,
  author: 56,
  homepage: 1_024,
  version: 36,
};

export interface ParsedMusicSourceScript {
  readonly metadata: MusicSourceMetadata;
  readonly script: string;
}

export function parseMusicSourceScript(script: string): ParsedMusicSourceScript {
  const bytes = new TextEncoder().encode(script);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCRIPT_BYTES) {
    throw musicSourceError(
      "INITIALIZATION_FAILED",
      "Music source must contain 1 to 524288 UTF-8 bytes",
    );
  }

  const header = /^\/\*[\s\S]+?\*\//u.exec(script)?.[0];
  if (header === undefined) {
    throw musicSourceError(
      "INITIALIZATION_FAILED",
      "Music source must start with an LX metadata block",
    );
  }

  const values = new Map<string, string>();
  for (const line of header.split(/\r?\n/u)) {
    const match = /^\s?\*\s?@(\w+)\s(.+)$/u.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2].trim());
  }

  const name = limit(values.get("name") ?? "music-source", INFO_LIMITS.name);
  const homepage = values.get("homepage") || values.get("repository") || "";
  return {
    script,
    metadata: MusicSourceMetadata.make({
      name,
      description: limit(values.get("description") ?? "", INFO_LIMITS.description),
      author: limit(values.get("author") ?? "", INFO_LIMITS.author),
      homepage: limit(homepage, INFO_LIMITS.homepage),
      version: limit(values.get("version") ?? "", INFO_LIMITS.version),
      digest: createHash("sha256").update(bytes).digest("hex"),
    }),
  };
}

function limit(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum)}...` : value;
}
