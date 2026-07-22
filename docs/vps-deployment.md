# Bun VPS 部署

蛇域在 VPS 上使用单个 Bun 进程供应静态 SPA、HTTP API 和 WebSocket。游戏房间保存在进程内，因此生产环境只启动一个应用实例；systemd 负责异常重启。

## 1. 安装运行环境

以下示例以 Debian/Ubuntu 为例：

```bash
sudo apt update
sudo apt install -y curl unzip coturn certbot acl
sudo useradd --create-home --shell /bin/bash serpentia
sudo -u serpentia -H bash -lc 'curl -fsSL https://bun.sh/install | bash'
sudo mkdir -p /opt/serpentia
sudo chown serpentia:serpentia /opt/serpentia
```

将仓库部署到 `/opt/serpentia`，然后：

```bash
sudo -u serpentia -H bash -lc 'cd /opt/serpentia && bun install --frozen-lockfile && bun run build'
```

## 2. 应用密钥

```bash
cd /opt/serpentia
sudo -u serpentia -H /home/serpentia/.bun/bin/bun run backend:secrets -- friend-a friend-b
sudo -u serpentia cp .env.example .env
sudo -u serpentia chmod 600 .env
```

把命令输出的 `ACCESS_KEY_HASHES` 与 `SESSION_SIGNING_SECRET` 写入 `.env`。访问码只显示一次，应分别交给对应玩家。

## 3. HTTPS 证书

浏览器在公网使用麦克风需要安全上下文，因此生产环境必须使用 HTTPS。Bun 直接加载证书，不需要反向代理：

```bash
sudo certbot certonly --standalone -d snake.example.com
sudo certbot certonly --standalone -d voice.example.com
sudo setfacl -R -m u:serpentia:rX /etc/letsencrypt/live /etc/letsencrypt/archive
```

应用配置：

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=443
TRUST_PROXY=false
COOKIE_SECURE=true
TLS_CERT_FILE=/etc/letsencrypt/live/snake.example.com/fullchain.pem
TLS_KEY_FILE=/etc/letsencrypt/live/snake.example.com/privkey.pem
```

证书续期后重启 Bun 以重新加载证书：

```bash
sudo certbot renew --deploy-hook 'setfacl -R -m u:serpentia:rX /etc/letsencrypt/live /etc/letsencrypt/archive && systemctl restart serpentia coturn'
```

## 4. coturn

生成共享密钥：

```bash
openssl rand -hex 32
```

把 [`deploy/coturn.conf.example`](../deploy/coturn.conf.example) 安装到 `/etc/turnserver.conf`，将 `static-auth-secret`、域名和证书路径替换为实际值。相同密钥写入应用 `.env`：

```dotenv
STUN_URLS=stun:voice.example.com:3478
TURN_URLS=turn:voice.example.com:3478?transport=udp,turn:voice.example.com:3478?transport=tcp,turns:voice.example.com:5349?transport=tcp
TURN_SHARED_SECRET=同一个-static-auth-secret
```

启动 coturn：

```bash
sudo systemctl enable --now coturn
```

防火墙至少开放：

- TCP `80`：Let's Encrypt 证书签发/续期
- TCP `443`：Bun HTTPS/WSS
- UDP/TCP `3478`：STUN/TURN
- TCP `5349`：TURN TLS
- UDP `49160:49200`：coturn relay 端口范围

## 5. systemd

```bash
sudo cp /opt/serpentia/deploy/serpentia.service /etc/systemd/system/serpentia.service
sudo systemctl daemon-reload
sudo systemctl enable --now serpentia
sudo systemctl status serpentia
```

健康检查：

```bash
curl https://snake.example.com/healthz
```

应返回 `ok`。

## 6. 更新

```bash
cd /opt/serpentia
git pull --ff-only
sudo -u serpentia -H /home/serpentia/.bun/bin/bun install --frozen-lockfile
sudo -u serpentia -H /home/serpentia/.bun/bin/bun run ready
sudo systemctl restart serpentia
```

不要并行启动多个 Bun 实例，否则同一个朋友房间会被拆分到不同进程。需要水平扩展时，应先引入共享房间路由与跨实例状态协调。
