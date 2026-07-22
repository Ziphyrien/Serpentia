import { generateAccessKey, hashAccessKey } from "../src/lib/server/access/access-key";

const PLAYER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const playerIds = process.argv.slice(2);

if (playerIds.length === 0) {
  console.error("Usage: bun run backend:secrets -- friend-a friend-b");
  process.exitCode = 1;
} else if (new Set(playerIds).size !== playerIds.length) {
  console.error("Player IDs must be unique");
  process.exitCode = 1;
} else if (playerIds.some((playerId) => !PLAYER_ID_PATTERN.test(playerId))) {
  console.error("Player IDs must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/");
  process.exitCode = 1;
} else {
  const records: Array<{ readonly playerId: string; readonly hash: string }> = [];
  const codes: Array<{ readonly playerId: string; readonly accessCode: string }> = [];

  for (const playerId of playerIds) {
    const accessCode = generateAccessKey();
    const hash = await hashAccessKey(accessCode);
    if (hash === undefined) throw new Error("Generated access code could not be hashed");
    records.push({ playerId, hash });
    codes.push({ playerId, accessCode });
  }

  const signingSecret = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  console.log("Friend access codes (display once):");
  for (const code of codes) console.log(`${code.playerId}: ${code.accessCode}`);
  console.log("\nWrangler secret values:");
  console.log(`ACCESS_KEY_HASHES=${JSON.stringify(records)}`);
  console.log(`SESSION_SIGNING_SECRET=${signingSecret}`);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
