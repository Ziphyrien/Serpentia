import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { BilibiliFetch } from "./client";
import { BilibiliCredentials } from "./credentials";
import { BilibiliSessionRefresher } from "./refresh";

const oldCookie =
  "SESSDATA=old-session; bili_jct=old-csrf; DedeUserID=1; DedeUserID__ckMd5=old-md5";

describe("Bilibili Web Cookie refresh", () => {
  it("rotates, persists, and confirms credentials without losing unrelated cookies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "serpentia-bilibili-refresh-"));
    const environmentFile = join(directory, ".env");
    await writeFile(environmentFile, "PORT=3000\nBILIBILI_COOKIE='stale'\n", "utf8");
    const calls: Array<string> = [];
    const fetcher: BilibiliFetch = async (input, init) => {
      const request = new Request(input, init);
      calls.push(request.url);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/cookie/info")) {
        expect(request.headers.get("cookie")).toContain("SESSDATA=old-session");
        return Response.json({
          code: 0,
          data: { refresh: true, timestamp: 1_700_000_000_000 },
        });
      }
      if (url.pathname.startsWith("/correspond/1/")) {
        expect(url.pathname.split("/").at(-1)).toMatch(/^[0-9a-f]{256}$/u);
        return new Response('<div id="1-name">0123456789abcdef0123456789abcdef</div>');
      }
      if (url.pathname.endsWith("/cookie/refresh")) {
        const form = new URLSearchParams(await request.text());
        expect(form.get("csrf")).toBe("old-csrf");
        expect(form.get("refresh_token")).toBe("old-refresh-token-1234");
        const headers = new Headers({ "content-type": "application/json" });
        headers.append("set-cookie", "SESSDATA=new-session; Path=/; HttpOnly; Secure");
        headers.append("set-cookie", "bili_jct=new-csrf; Path=/");
        headers.append("set-cookie", "sid=new-sid; Path=/");
        return new Response(
          JSON.stringify({
            code: 0,
            data: { status: 0, refresh_token: "new-refresh-token-5678" },
          }),
          { headers },
        );
      }
      if (url.pathname.endsWith("/confirm/refresh")) {
        expect(request.headers.get("cookie")).toContain("SESSDATA=new-session");
        const form = new URLSearchParams(await request.text());
        expect(form.get("csrf")).toBe("new-csrf");
        expect(form.get("refresh_token")).toBe("old-refresh-token-1234");
        return Response.json({ code: 0 });
      }
      return new Response(null, { status: 404 });
    };

    try {
      const credentials = BilibiliCredentials.fromEnvironment(oldCookie);
      const refresher = new BilibiliSessionRefresher(credentials, {
        refreshToken: "old-refresh-token-1234",
        environmentFile,
        fetch: fetcher,
        now: () => 1_700_000_000_000,
      });
      await refresher.ensureFresh();
      await refresher.ensureFresh();

      expect(credentials.headerValue()).toContain("SESSDATA=new-session");
      expect(credentials.headerValue()).toContain("DedeUserID=1");
      expect(calls).toHaveLength(4);
      const persisted = await readFile(environmentFile, "utf8");
      expect(persisted).toContain("PORT=3000");
      expect(persisted).toContain("BILIBILI_COOKIE='SESSDATA=new-session;");
      expect(persisted).toContain("BILIBILI_REFRESH_TOKEN='new-refresh-token-5678'");
      if (process.platform !== "win32") {
        expect((await stat(environmentFile)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
