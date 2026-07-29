import { defineConfig } from "vite-plus";
import tailwindcss from "@tailwindcss/vite";
import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";

export default defineConfig({
  fmt: { ignorePatterns: [".repos/**", "build/**"] },
  lint: {
    ignorePatterns: [".repos/**", "build/**"],
    options: { typeAware: true, typeCheck: true },
  },
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
      },
      adapter: adapter({
        fallback: "200.html",
        precompress: true,
        strict: true,
      }),
    }),
  ],
  test: {
    expect: { requireAssertions: true },
    projects: [
      {
        extends: "./vite.config.ts",
        test: {
          name: "server",
          environment: "node",
          include: ["src/**/*.spec.{js,ts}", "tests/integration/**/*.integration.spec.{js,ts}"],
          exclude: ["src/**/*.svelte.{test,spec}.{js,ts}"],
        },
      },
    ],
  },
});
