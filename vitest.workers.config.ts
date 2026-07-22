import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/lib/server/room/__tests__/worker-entry.ts",
      miniflare: {
        compatibilityDate: "2026-07-21",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { GAME_ROOM: "GameRoom" },
        bindings: {
          ACCESS_KEY_HASHES: "[]",
          SESSION_SIGNING_SECRET: "test-signing-secret-with-at-least-32-characters",
        },
      },
    }),
  ],
  test: {
    expect: { requireAssertions: true },
    include: ["src/**/*.worker.spec.ts"],
  },
});
