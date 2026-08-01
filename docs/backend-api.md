# 蛇域后端接口

Bun 后端提供朋友房间所需的鉴权、房间协调、服务端权威模拟、状态广播、断线续局和 WebRTC P2P 信令。前端不得直接修改权威游戏状态，也不得通过游戏 WebSocket 传输音频。

共享 TypeScript 契约位于 `src/lib/protocol/index.ts`。前端应优先直接导入其中的消息、快照和 HTTP 类型，而不是复制一份可能漂移的声明。

## 启动信息

```http
GET /api/game
```

返回 `BackendDescriptor`，包括：

- 协议版本、房间 ID、tick 与快照频率
- 地图尺寸、移动/加速/转向、长度和重生等前端预测规则
- 会话、TURN 凭据、音乐解析和 WebSocket 路径
- 断线续局窗口
- 消息大小及频率限制
- P2P 语音模式和公共 STUN 配置

该端点不需要游戏会话，可以作为前端启动探针。

## 会话

所有会话响应都带有 `Cache-Control: no-store`。

### 查询

```http
GET /api/session
```

会话有效：

```json
{
  "authenticated": true,
  "playerId": "550e8400-e29b-41d4-a716-446655440000",
  "nickname": "Alpha",
  "skinId": 1,
  "expiresAt": 1784740000000
}
```

无会话或会话过期：

```json
{ "authenticated": false }
```

### 创建游戏会话

```http
POST /api/session
Content-Type: application/json

{
  "nickname": "Alpha",
  "skinId": 1
}
```

`skinId` 可省略；服务端会校验它是否属于内置皮肤清单，无效或缺省时使用默认皮肤。成功后为本次会话生成独立 `playerId`，并设置 `HttpOnly`、`SameSite=Strict` 的 `serpentia_session` cookie。

可能的错误码：

- `INVALID_REQUEST`：Content-Type、JSON、昵称或皮肤参数格式无效
- `RATE_LIMITED`：同一来源的会话令牌桶暂时耗尽；按响应的 `Retry-After` 重试
- `RUNTIME_UNAVAILABLE`：Bun 服务或房间暂不可用
- `SERVER_MISCONFIGURED`：生产 secret 缺失或格式错误

### 结束会话并返回首页

```http
DELETE /api/session
```

清除会话 cookie，成功返回 `204`。

## TURN 凭据

```http
POST /api/turn-credentials
```

该端点要求有效的 `serpentia_session` cookie。后端使用 coturn `static-auth-secret` 生成符合 TURN REST API 规范的短期 HMAC-SHA1 凭据，长期共享密钥不会返回浏览器：

```json
{
  "iceServers": [
    { "urls": ["stun:voice.example.com:3478"] },
    {
      "urls": [
        "turn:voice.example.com:3478?transport=udp",
        "turn:voice.example.com:3478?transport=tcp",
        "turns:voice.example.com:5349?transport=tcp"
      ],
      "username": "1784761600:550e8400-e29b-41d4-a716-446655440000",
      "credential": "temporary-hmac-credential"
    }
  ],
  "expiresAt": 1784761600000,
  "refreshAfter": 1784760700000
}
```

凭据有效期为 6 小时；前端应在 `refreshAfter` 后重新请求，并通过 `RTCPeerConnection.setConfiguration()` 更新 `iceServers`。每位玩家十分钟最多签发 12 次。

可能的错误码：

- `UNAUTHORIZED`：会话不存在或已过期
- `RATE_LIMITED`：凭据请求过于频繁
- `RUNTIME_UNAVAILABLE`：Bun 房间协调暂不可用
- `SERVER_MISCONFIGURED`：coturn 或会话 Secret 缺失
- `TURN_UNAVAILABLE`：coturn 临时凭据生成失败

## 哔哩哔哩音乐

服务启动时必须读取成对的 `BILIBILI_COOKIE` 与 `BILIBILI_REFRESH_TOKEN`。Cookie 至少包含非空 `SESSDATA` 和 `bili_jct`；`BILIBILI_ENV_FILE` 指向服务可写、权限为 `0600` 的凭据环境文件，默认是工作目录下的 `.env`。使用网页二维码登录脚本生成匹配凭据，脚本和服务都不会输出秘密：

```bash
bun run bilibili:login -- --env .env
```

受限客户端只会把 Cookie 注入固定的 Bilibili API，以及官方 Cookie 检查、Correspond、刷新和确认端点；Cookie 不会进入浏览器、WebSocket、签名引用、流票据或日志。服务启动后会非阻塞检查一次，此后每 24 小时检查；临时失败每小时重试，前台请求会与后台任务共享同一个单飞检查。需要刷新时按 `cookie/info → correspond → cookie/refresh → confirm/refresh` 顺序轮换。新 Cookie 与新 refresh token 会先原子写回 `BILIBILI_ENV_FILE` 并更新进程内凭据，再使用新 Cookie 和旧 refresh token 确认轮换。持久化或刷新失败不会用半成品覆盖旧凭据。

音乐协议只支持 `64k`、`132k`、`192k`，分别对应 DASH audio id `30216`、`30232`、`30280`。目标档位不存在时按 `192k → 132k → 64k` 向下降级；旧视频的 `durl` 作为最终 `64k` 兼容路径。

### 状态

```http
GET /api/music
Cookie: serpentia_session=...
```

要求有效游戏会话。响应会验证服务器 Bilibili 登录与 WBI keys，不返回 UID、昵称或任何凭据：

```json
{
  "source": "bilibili",
  "available": true,
  "qualities": ["64k", "132k", "192k"]
}
```

### 搜索

```http
POST /api/music/search
Content-Type: application/json
Cookie: serpentia_session=...

{ "query": "周杰伦", "page": 1 }
```

该端点要求有效游戏会话并按玩家限流。`page` 可省略且默认为 1；服务端缓存 WBI keys，并对 `/x/web-interface/wbi/search/type` 的单页请求签名。响应中的 `nextPage` 为下一页页码或 `null`。客户端收到第一页后立即渲染，并在后台补齐首批 100 条；浏览到第 60 条后继续静默预取下一批 100 条，之后按相同间隔递进。标题会去除高亮标签并解码 HTML entities。每首结果的 `qualities` 表示共享代理稳定支持的音质上限，不保证该视频具有对应音轨。目标档位不存在时，服务端按 `192k → 132k → 64k` 自动降级，并在 `MusicResolvedTrack.quality` 中广播实际音质。`reference` 是短期 HMAC 签名引用，客户端只能原样提交给房间点播，不能提交裸 BVID、CID、标题或 URL。

```json
{
  "total": 1,
  "tracks": [
    {
      "bvid": "BV1xx411c7mD",
      "title": "示例歌曲",
      "artist": "示例 UP 主",
      "durationSeconds": 180,
      "pictureUrl": "https://i0.hdslb.com/example.jpg",
      "qualities": ["64k", "132k", "192k"],
      "reference": "<signed-track-reference>"
    }
  ],
  "nextPage": null
}
```

不存在公开 `/api/music/resolve`。点播通过 WebSocket 提交：

```json
{
  "v": 16,
  "_tag": "music-control",
  "command": {
    "_tag": "play",
    "reference": "<signed-track-reference>",
    "quality": "192k"
  }
}
```

服务端验证引用，缺 CID 时从 `/x/player/pagelist` 选择第一分 P，再调用 WBI `/x/player/wbi/playurl`。标题、作者、封面和 BVID 均取自签名引用，而不是客户端字段。房间最终只广播同源 `/api/music/stream/<signed-stream-ticket>`，短期 CDN URL 仅缓存在服务端内存中。点播失败时仅向发起者发送 `{ "v": 16, "_tag": "music-error", "code": "..." }`，不会压扁为通用房间错误。

### 音频流

```http
GET /api/music/stream/<signed-stream-ticket>
HEAD /api/music/stream/<signed-stream-ticket>
Cookie: serpentia_session=...
Range: bytes=0-
```

流端点要求有效游戏会话，只接受短期签名票据，支持 GET、HEAD 和单一 bytes Range。代理仅访问受控 Bilibili 媒体域名，注入 `Referer` 与 `User-Agent`，不向 CDN 发送账号 Cookie；只透传音频必需 headers，过滤 `Set-Cookie` 等敏感头。临时 URL 失效或候选失败时最多强制刷新一次，全程流式转发，不缓冲整首音频。

音乐错误码：

- `INVALID_REQUEST`
- `UNAUTHORIZED`
- `RATE_LIMITED`
- `AUTH_REQUIRED`
- `RISK_CONTROLLED`
- `VIDEO_UNAVAILABLE`
- `AUDIO_UNAVAILABLE`
- `UPSTREAM_FAILED`
- `TIMEOUT`
- `BACKEND_UNAVAILABLE`
- `POLICY_DENIED`

## WebSocket

同源浏览器连接：

```text
wss://<host>/api/parties/game-room/friends
```

浏览器会自动携带 HttpOnly 会话 cookie。后端忽略客户端伪造的身份 header，并根据签名会话注入 `playerId` 和昵称。

所有客户端 JSON 消息必须包含：

```json
{ "v": 16, "_tag": "..." }
```

当前单条客户端消息上限为 65,536 bytes，客户端只发送文本帧。服务端控制消息使用 JSON 文本，10 Hz `snapshot` 使用快照格式 v3 的有状态二进制 keyframe/delta。

### 客户端消息

方向输入：

```json
{
  "v": 16,
  "_tag": "input",
  "sequence": 42,
  "targetTick": 1203,
  "angle": 1.5707963267948966,
  "boosting": true
}
```

- `sequence` 必须单调递增，且不超过 JavaScript 安全整数
- `targetTick` 是输入应生效的权威 tick；过旧输入会在下一个可执行 tick 生效，超出未来窗口的输入会被拒绝
- `angle` 是有限弧度值
- 客户端只提交意图；实际转向、速度和加速消耗由服务器决定
- 每个连接最多 40 条输入消息/秒
- 服务端真正处理输入后发送 `input-ack`；`targetTick` 保留请求值，`appliedTick` 给出实际生效 tick
- `SnakeSnapshot.lastInputSequence` 与 `lastInputAppliedTick` 构成权威确认点；重连后新序号必须从确认序号继续递增
- `SnakeSnapshot.targetAngle` 是服务端当前转向目标；客户端从权威快照回放时应以它为起点，不能只用当前 `angle` 猜测下一 tick

输入执行确认：

```json
{
  "v": 16,
  "_tag": "input-ack",
  "sequence": 42,
  "targetTick": 1203,
  "appliedTick": 1204
}
```

心跳：

```json
{ "v": 16, "_tag": "ping", "nonce": "client-value" }
```

语音收听与麦克风状态：

```json
{
  "v": 16,
  "_tag": "voice-state",
  "listening": true,
  "microphoneEnabled": false,
  "muted": true
}
```

`listening=true` 加入语音信令并允许接收队友音频，不要求麦克风权限；`microphoneEnabled` 独立表示是否发布本地麦克风轨道。未开麦时服务端会强制 roster 中的 `muted=true`，但该成员仍可交换 P2P 信令。`listening=false` 才会离开语音 roster。旧 `{ "joined", "muted" }` 格式在 v3 中无效。前端仍必须实际创建、禁用或停止本地音轨。

P2P 信令：

```json
{
  "v": 16,
  "_tag": "voice-signal",
  "targetPlayerId": "friend-b",
  "signal": { "_tag": "offer", "sdp": "..." }
}
```

```json
{
  "v": 16,
  "_tag": "voice-signal",
  "targetPlayerId": "friend-a",
  "signal": { "_tag": "answer", "sdp": "..." }
}
```

```json
{
  "v": 16,
  "_tag": "voice-signal",
  "targetPlayerId": "friend-b",
  "signal": {
    "_tag": "ice",
    "candidate": "candidate:...",
    "sdpMid": "0",
    "sdpMLineIndex": 0,
    "usernameFragment": null
  }
}
```

ICE 收集结束时允许 `candidate: null`。后端只向已认证且在线的目标成员转发信令。

### 服务端消息

连接成功首先收到 `welcome`：

```json
{
  "v": 16,
  "_tag": "welcome",
  "selfPlayerId": "friend-a",
  "resumed": false,
  "sessionExpiresAt": 1784780000000,
  "serverTime": 1784740000000,
  "room": {},
  "snapshot": {},
  "voice": []
}
```

之后通常以 10Hz 收到二进制 `snapshot`；解码后的逻辑结构如下：

```json
{
  "v": 16,
  "_tag": "snapshot",
  "serverTime": 1784740000100,
  "snapshot": {},
  "events": []
}
```

`snapshot` 是完整权威状态，包含蛇、食物和实时排行榜。`events` 汇总自上次快照后的死亡、食物消费和重生事件。发生死亡、重生或断线过期时会提前广播。

其他服务端消息：

- `voice-roster`：仅包含当前收听成员，并分别给出 `microphoneEnabled` 与 `muted`
- `voice-signal`：包含可信的 `fromPlayerId` 及 offer/answer/ICE
- `pong`：回显 nonce，并附服务端时间
- `error`：稳定错误码和 `retryable` 提示

WebSocket 错误码：

- `INVALID_MESSAGE`
- `MESSAGE_TOO_LARGE`
- `RATE_LIMITED`
- `STALE_INPUT`
- `SESSION_EXPIRED`
- `NICKNAME_IN_USE`
- `VOICE_NOT_AUTHORIZED`
- `VOICE_SELF_TARGET`
- `VOICE_TARGET_UNAVAILABLE`

## 重连与房间规则

- 同一 `playerId` 只能有一个活跃连接；新连接会以关闭码 `4001` 替换旧连接
- 断线后蛇保留 5 秒并停止加速；窗口内重连会收到 `resumed: true`
- 超出窗口后蛇和昵称占用被移除，再连接会创建新蛇
- 昵称经过 NFKC、大小写和空白规范化后必须唯一
- 新连接被拒绝时会先收到 `NICKNAME_IN_USE`，随后以 `4409` 关闭
- 频率超限会收到 `RATE_LIMITED`，随后以 `4429` 关闭

## P2P 语音前端职责

1. 创建游戏会话后调用 `/api/turn-credentials` 获取完整 `iceServers`
2. 使用 `iceTransportPolicy: "all"` 创建 `RTCPeerConnection`，保持直连优先、TURN 自动兜底
3. roster 新增成员时，为每位远端成员建立一条连接
4. 为避免双方同时 offer，可约定字典序较小的 `playerId` 主动创建 offer
5. 通过 `voice-signal` 交换 offer、answer 和 ICE
6. 首次建连即预协商 `sendrecv` 音频 transceiver；未开麦时 sender track 为 `null`，开关麦使用 `replaceTrack(track | null)`，接收端通过 `ontrack` 播放音频
7. `refreshAfter` 到达后刷新凭据并调用 `setConfiguration()`
8. 成员离开 roster 时关闭对应 `RTCPeerConnection`

默认媒体拓扑仍是浏览器 WebRTC P2P mesh：能够直连时走 STUN/P2P；双方对称 NAT 等无法打洞的情况自动走 VPS 上的 coturn。没有接入 SFU，游戏 WebSocket 不承载音频。

## 生产配置

生成独立会话签名 secret：

```bash
bun run backend:secrets
```

该命令只输出到终端，不写入仓库。将输出的值写入 VPS 的 `.env`，并配置 Bun/TLS/coturn：

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=443
COOKIE_SECURE=true
TLS_CERT_FILE=/etc/letsencrypt/live/snake.example.com/fullchain.pem
TLS_KEY_FILE=/etc/letsencrypt/live/snake.example.com/privkey.pem
SESSION_SIGNING_SECRET=...
STUN_URLS=stun:voice.example.com:3478
TURN_URLS=turn:voice.example.com:3478?transport=udp,turns:voice.example.com:5349?transport=tcp
TURN_SHARED_SECRET=...
BILIBILI_COOKIE='SESSDATA=...; bili_jct=...; DedeUserID=...'
BILIBILI_REFRESH_TOKEN='与上述 Cookie 匹配的 refresh token'
BILIBILI_ENV_FILE=.env
```

生产前执行：

```bash
bun run test
bun run check
bun run build
```

会话 cookie 使用 `SameSite=Strict`，因此前端、API 和 WebSocket 必须由同一个 Bun 服务同源供应。生产语音需要 HTTPS；Bun 可通过 `TLS_CERT_FILE` 和 `TLS_KEY_FILE` 直接终止 TLS。完整部署步骤见 [`vps-deployment.md`](vps-deployment.md)。
