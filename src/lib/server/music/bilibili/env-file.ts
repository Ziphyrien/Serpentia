import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { bilibiliError } from "./errors";

const BILIBILI_COOKIE_KEY = "BILIBILI_COOKIE";
const BILIBILI_REFRESH_TOKEN_KEY = "BILIBILI_REFRESH_TOKEN";

export interface BilibiliEnvironmentValues {
  readonly cookie: string;
  readonly refreshToken: string;
}

export async function writeBilibiliEnvironmentFile(
  path: string,
  values: BilibiliEnvironmentValues,
): Promise<void> {
  const target = resolve(path);
  await assertRegularOrMissing(target);
  const original = await readOptionalText(target);
  const lineEnding = original.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = original.endsWith("\n") || original.length === 0;
  const replacements = new Map([
    [BILIBILI_COOKIE_KEY, encodeEnvironmentValue(values.cookie)],
    [BILIBILI_REFRESH_TOKEN_KEY, encodeEnvironmentValue(values.refreshToken)],
  ]);
  const seen = new Set<string>();
  const lines = original.length === 0 ? [] : original.replace(/\r?\n$/u, "").split(/\r?\n/u);
  const nextLines: Array<string> = [];

  for (const line of lines) {
    const key = environmentAssignmentKey(line);
    if (key === undefined || !replacements.has(key)) {
      nextLines.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    nextLines.push(`${key}=${replacements.get(key)}`);
    seen.add(key);
  }
  for (const [key, value] of replacements) {
    if (!seen.has(key)) nextLines.push(`${key}=${value}`);
  }

  const content = nextLines.join(lineEnding) + (hadFinalNewline ? lineEnding : "");
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch {
    throw bilibiliError(
      "INVALID_CONFIG",
      "environment.persist",
      "Unable to persist refreshed Bilibili credentials",
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function environmentAssignmentKey(line: string): string | undefined {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
  return match?.[1];
}

function encodeEnvironmentValue(value: string): string {
  if (!value || /[\u0000-\u001f\u007f']/u.test(value)) {
    throw bilibiliError(
      "INVALID_CONFIG",
      "environment.encode",
      "Bilibili credential cannot be encoded safely",
    );
  }
  return `'${value}'`;
}

async function assertRegularOrMissing(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw bilibiliError(
        "INVALID_CONFIG",
        "environment.persist",
        "Bilibili environment path must be a regular file",
      );
    }
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
    throw cause;
  }
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return "";
    throw cause;
  }
}
