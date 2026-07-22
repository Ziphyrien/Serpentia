import { appendFile } from "node:fs/promises";

const workerPath = ".svelte-kit/cloudflare/_worker.js";
const exportLine = 'export { GameRoom } from "../../src/lib/server/room/game-room.ts";\n';

await appendFile(workerPath, `\n${exportLine}`);
