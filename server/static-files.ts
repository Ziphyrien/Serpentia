import { resolve, sep } from "node:path";

/** 供应 adapter-static 输出，支持 Brotli/Gzip 与 SPA fallback。 */
export class StaticFileServer {
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  async assertReady(): Promise<void> {
    if (!(await Bun.file(resolve(this.root, "index.html")).exists())) {
      throw new Error(`Static build not found at ${this.root}; run bun run build first`);
    }
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const relative = pathname.replace(/^\/+/, "") || "index.html";
    const candidate = this.safePath(relative);
    if (candidate !== undefined && (await Bun.file(candidate).exists())) {
      return this.fileResponse(request, candidate, pathname);
    }
    if (pathname.startsWith("/_app/") || /\.[A-Za-z0-9]+$/u.test(pathname)) {
      return new Response("Not found", { status: 404 });
    }

    // 客户端路由回落到 SPA shell
    return this.fileResponse(request, resolve(this.root, "index.html"), "/index.html");
  }

  private safePath(relative: string): string | undefined {
    const candidate = resolve(this.root, relative);
    if (candidate !== this.root && !candidate.startsWith(`${this.root}${sep}`)) return undefined;
    return candidate;
  }

  private async fileResponse(
    request: Request,
    originalPath: string,
    requestPath: string,
  ): Promise<Response> {
    const acceptEncoding = request.headers.get("accept-encoding") ?? "";
    let selectedPath = originalPath;
    let contentEncoding: string | undefined;

    if (acceptEncoding.includes("br") && (await Bun.file(`${originalPath}.br`).exists())) {
      selectedPath = `${originalPath}.br`;
      contentEncoding = "br";
    } else if (acceptEncoding.includes("gzip") && (await Bun.file(`${originalPath}.gz`).exists())) {
      selectedPath = `${originalPath}.gz`;
      contentEncoding = "gzip";
    }

    const original = Bun.file(originalPath);
    const selected = Bun.file(selectedPath);
    const headers = new Headers({
      "cache-control": cacheControl(requestPath),
      "content-type": original.type || "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    if (contentEncoding !== undefined) {
      headers.set("content-encoding", contentEncoding);
      headers.set("vary", "Accept-Encoding");
    }

    return new Response(request.method === "HEAD" ? null : selected, { headers });
  }
}

function cacheControl(pathname: string): string {
  if (pathname.startsWith("/_app/immutable/")) return "public, max-age=31536000, immutable";
  if (pathname === "/index.html" || pathname === "/") return "no-cache";
  return "public, max-age=86400";
}
