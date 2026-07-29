# 蛇域

Bun、Svelte 5 和 PixiJS 驱动的朋友多人贪吃蛇。游戏采用服务端权威模拟，支持断线续局、排行榜、移动端摇杆、P2P 语音和 coturn 中继。

## 架构

```text
Bun.serve (HTTP / WebSocket / TLS)
  -> GameRoom
    -> RoomController
      -> GameEngine
```

前端由 SvelteKit `adapter-static` 构建为混合静态应用：游戏入口预渲染为真实 HTML，`/game` 路由作为依赖 Pixi、WebRTC 与 WebSocket 的客户端 SPA；Bun 同一进程供应静态资源、HTTP API 和 WebSocket。后端协议定义位于 `src/lib/protocol`，接口说明见 [`docs/backend-api.md`](docs/backend-api.md)。

Kotlin 沉浸式 Android 客户端位于 [`android/`](android/README.md)。其 JDK、Android SDK、Gradle 和依赖缓存均可安装在 D 盘。

Web 客户端同时提供 SvelteKit 原生 PWA：应用壳、图标、贴图和音效可离线加载，安装后以全屏模式启动；普通移动浏览器标签页会在用户首次及后续触摸时请求全屏。创建游戏会话、多人游戏、语音和实时状态仍必须连接服务器。

## 本地运行

```bash
bun install
bun run backend:secrets
cp .env.example .env
```

把生成的 `SESSION_SIGNING_SECRET` 写入 `.env`。本地 HTTP 调试时设置：

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
COOKIE_SECURE=false
TLS_CERT_FILE=
TLS_KEY_FILE=
```

启动完整应用：

```bash
bun run dev
```

仅调试前端 UI 可运行 `bun run dev:ui`，但该模式不提供 Bun API 和游戏 WebSocket。

## 生产运行

```bash
bun install --frozen-lockfile
bun run ready
bun run start
```

VPS、systemd、TLS 和 coturn 配置见 [`docs/vps-deployment.md`](docs/vps-deployment.md)。
