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
- 会话、TURN 凭据和 WebSocket 路径
- 断线续局窗口
- 消息大小及频率限制
- P2P 语音模式和公共 STUN 配置

该端点不需要登录，可以作为前端启动探针。

## 会话

所有会话响应都带有 `Cache-Control: no-store`。

### 查询

```http
GET /api/session
```

已登录：

```json
{
  "authenticated": true,
  "playerId": "friend-a",
  "nickname": "Alpha",
  "expiresAt": 1784740000000
}
```

未登录或会话过期：

```json
{ "authenticated": false }
```

### 登录

```http
POST /api/session
Content-Type: application/json

{
  "key": "XXXX-XXXX-XXXX",
  "nickname": "Alpha"
}
```

成功后设置 `HttpOnly`、`SameSite=Strict` 的 `serpentia_session` cookie。长期访问码不会进入 WebSocket URL，也不会返回给前端。

可能的错误码：

- `INVALID_REQUEST`：Content-Type、JSON 或字段格式无效
- `INVALID_ACCESS`：访问码或昵称无效
- `RATE_LIMITED`：同一来源一分钟内尝试过多
- `RUNTIME_UNAVAILABLE`：Bun 服务或房间暂不可用
- `SERVER_MISCONFIGURED`：生产 secret 缺失或格式错误

### 退出

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
      "username": "1784761600:friend-a",
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

## WebSocket

同源浏览器连接：

```text
wss://<host>/api/parties/game-room/friends
```

浏览器会自动携带 HttpOnly 会话 cookie。后端忽略客户端伪造的身份 header，并根据签名会话注入 `playerId` 和昵称。

所有 JSON 消息必须包含：

```json
{ "v": 1, "_tag": "..." }
```

当前单条消息上限为 65,536 bytes。只接受文本帧。

### 客户端消息

方向输入：

```json
{
  "v": 1,
  "_tag": "input",
  "sequence": 42,
  "clientTick": 1200,
  "angle": 1.5707963267948966,
  "boosting": true
}
```

- `sequence` 必须单调递增，且不超过 JavaScript 安全整数
- `clientTick` 应填写客户端最近一次收到的权威 `snapshot.tick`；过旧或超前输入会被拒绝
- `angle` 是有限弧度值
- 客户端只提交意图；实际转向、速度和加速消耗由服务器决定
- 每个连接最多 40 条输入消息/秒
- `SnakeSnapshot.lastInputSequence` 是服务端确认序号，可用于客户端预测回滚；重连后新序号必须从该值继续递增

心跳：

```json
{ "v": 1, "_tag": "ping", "nonce": "client-value" }
```

麦克风成员状态：

```json
{ "v": 1, "_tag": "voice-state", "muted": false }
```

该状态只更新房间 roster；前端仍必须实际启用或禁用本地音轨。

P2P 信令：

```json
{
  "v": 1,
  "_tag": "voice-signal",
  "targetPlayerId": "friend-b",
  "signal": { "_tag": "offer", "sdp": "..." }
}
```

```json
{
  "v": 1,
  "_tag": "voice-signal",
  "targetPlayerId": "friend-a",
  "signal": { "_tag": "answer", "sdp": "..." }
}
```

```json
{
  "v": 1,
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
  "v": 1,
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

之后通常以 10Hz 收到 `snapshot`：

```json
{
  "v": 1,
  "_tag": "snapshot",
  "serverTime": 1784740000100,
  "snapshot": {},
  "events": []
}
```

`snapshot` 是完整权威状态，包含蛇、食物和实时排行榜。`events` 汇总自上次快照后的死亡、食物消费和重生事件。发生死亡、重生或断线过期时会提前广播。

其他服务端消息：

- `voice-roster`：当前连麦成员和静音状态
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

1. 登录后调用 `/api/turn-credentials` 获取完整 `iceServers`
2. 使用 `iceTransportPolicy: "all"` 创建 `RTCPeerConnection`，保持直连优先、TURN 自动兜底
3. roster 新增成员时，为每位远端成员建立一条连接
4. 为避免双方同时 offer，可约定字典序较小的 `playerId` 主动创建 offer
5. 通过 `voice-signal` 交换 offer、answer 和 ICE
6. 使用 `addTrack()` 和 `ontrack` 直接传输/播放音频
7. `refreshAfter` 到达后刷新凭据并调用 `setConfiguration()`
8. 成员离开 roster 时关闭对应 `RTCPeerConnection`

默认媒体拓扑仍是浏览器 WebRTC P2P mesh：能够直连时走 STUN/P2P；双方对称 NAT 等无法打洞的情况自动走 VPS 上的 coturn。没有接入 SFU，游戏 WebSocket 不承载音频。

## 生产配置

生成访问码、哈希注册表和独立会话签名 secret：

```bash
bun run backend:secrets -- friend-a friend-b
```

该命令只输出到终端，不写入仓库。访问码只展示一次，应分别交给对应朋友。

将命令输出的两个值写入 VPS 的 `.env`，并配置 Bun/TLS/coturn：

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=443
COOKIE_SECURE=true
TLS_CERT_FILE=/etc/letsencrypt/live/snake.example.com/fullchain.pem
TLS_KEY_FILE=/etc/letsencrypt/live/snake.example.com/privkey.pem
ACCESS_KEY_HASHES='[...]'
SESSION_SIGNING_SECRET=...
STUN_URLS=stun:voice.example.com:3478
TURN_URLS=turn:voice.example.com:3478?transport=udp,turns:voice.example.com:5349?transport=tcp
TURN_SHARED_SECRET=...
```

`ACCESS_KEY_HASHES` 的格式为：

```json
[
  { "playerId": "friend-a", "hash": "64-char-sha256-hex" },
  { "playerId": "friend-b", "hash": "64-char-sha256-hex" }
]
```

`playerId` 只能使用 ASCII 字母、数字、下划线和连字符。生产前执行：

```bash
bun run test
bun run check
bun run build
```

会话 cookie 使用 `SameSite=Strict`，因此前端、API 和 WebSocket 必须由同一个 Bun 服务同源供应。生产语音需要 HTTPS；Bun 可通过 `TLS_CERT_FILE` 和 `TLS_KEY_FILE` 直接终止 TLS。完整部署步骤见 [`vps-deployment.md`](vps-deployment.md)。
