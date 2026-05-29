# Cloudflare Tunnel Panel Docker

带 Web 面板的 `cloudflared` Docker 封装，用于运行、监控和守护 Cloudflare Tunnel。

## 功能

- Web 登录面板
- 实时状态、HA 连接数、心跳状态和日志
- 手动启动、停止、重连
- 心跳检测和异常自动重启 `cloudflared`
- Web 配置 Tunnel Token、协议、探测 URL、心跳间隔、超时、失败阈值和重连冷却
- 日志“清屏”和“清空”分离
- `/health` 轻量健康检查
- 配置持久化到 `/data/panel-config.json`

## GitHub Container Registry 部署

创建目录：

```bash
mkdir -p /opt/cloudflare-tunnel-panel
cd /opt/cloudflare-tunnel-panel
mkdir -p data
```

创建 `docker-compose.yml`：

```yaml
services:
  tunnel-panel:
    image: ghcr.io/zipenok/cloudflare-tunnel-docker:latest
    container_name: cloudflare-tunnel-panel
    restart: unless-stopped
    network_mode: host
    environment:
      PANEL_PORT: "18088"
      # PANEL_AUTH_TOKEN: "change-this-password"
      TUNNEL_PROTOCOL: "auto"
      HEARTBEAT_INTERVAL_MS: "60000"
      HEARTBEAT_TIMEOUT_MS: "10000"
      RESTART_FAILURE_THRESHOLD: "3"
      RESTART_COOLDOWN_MS: "120000"
      ORIGIN_PROBE_URL: ""
      ORIGIN_ACCEPT_STATUS_CODES: "200-299"
    volumes:
      - ./data:/data
```


启动：

```bash
docker compose up -d
```

打开面板：

```text
http://服务器IP:18088
```

默认不启用登录密码。需要面板登录保护时，取消注释 `PANEL_AUTH_TOKEN` 并设置强随机密码。

## 配置 Tunnel Token

推荐方式是在 Web 面板里配置：

1. 登录面板。
2. 点击 `设置`。
3. 填入 Cloudflare Tunnel Token。
4. 按需选择协议：`auto`、`quic`、`http2`。
5. 保存。

也可以直接在 compose 里添加：

```yaml
environment:
  TUNNEL_TOKEN: "你的 Cloudflare Tunnel Token"
```

Web 面板保存的配置会写入：

```text
./data/panel-config.json
```

Web 保存的 tunnel 和心跳配置优先于环境变量。`PANEL_PORT` 和 `PANEL_AUTH_TOKEN` 仍然只从环境变量读取。

## 心跳设置建议

推荐：

```text
心跳间隔：60000 ms
心跳超时：10000 ms
失败阈值：3
重连冷却：120000 ms
```

含义：

- 每 60 秒检测一次。
- 每次最多等 10 秒。
- 连续失败 3 次后重启 `cloudflared`。
- 重启后 120 秒内不再次自动重启。

面板会在 `cloudflared` 输出 `Registered tunnel connection` 时立即显示已连接，然后继续用 metrics 校准 HA 连接数。

如果你把面板自身穿透出去，可以把外部探测 URL 设置为：

```text
https://tunnel.example.com/health
```

`/health` 不需要登录，只返回轻量 JSON，不包含日志、Token 或敏感配置。

## 外部探测 URL

外部探测用于检测完整链路：

```text
面板容器 -> Cloudflare 公网 -> 域名 -> Tunnel -> 源站服务
```

推荐填一个稳定返回 `200` 的地址：

```text
https://your-domain.example.com/health
```

如果你的探测地址会返回 `401`、`403`、`404`，可以在面板里调整“接受状态码”：

```text
200-299,401,403
```

或者临时允许：

```text
200-499
```

更推荐最终使用返回 `200` 的健康检查地址。

## 日志按钮

- `清屏`：只隐藏当前浏览器里的旧日志，刷新或重启浏览器后仍保持隐藏。
- `清空`：清空后端日志缓存，所有打开的面板都会同步清空。

## API

需要登录或 Bearer Token 的接口：

```text
GET  /api/status
GET  /api/settings
POST /api/settings
POST /api/start
POST /api/stop
POST /api/restart
POST /api/logs/clear
GET  /events
```

免登录接口：

```text
GET /health
```

如果设置了 `PANEL_AUTH_TOKEN`，API 可使用：

```text
Authorization: Bearer your-panel-token
```

## 本地构建

```bash
docker build -t ghcr.io/zipenok/cloudflare-tunnel-docker:latest .
```

推送 GHCR：

```bash
docker login ghcr.io
docker push ghcr.io/zipenok/cloudflare-tunnel-docker:latest
```

或使用 buildx：

```bash
docker buildx build -t ghcr.io/zipenok/cloudflare-tunnel-docker:latest --push .
```

## GitHub Actions 自动构建

仓库已包含：

```text
.github/workflows/docker.yml
```

推送到 `main` 分支后会自动构建并推送：

```text
ghcr.io/zipenok/cloudflare-tunnel-docker:latest
```

推送 `v*.*.*` 标签时也会生成对应版本标签。

## DPanel 使用

在 DPanel 里新建 Compose/Stack，使用上面的 `docker-compose.yml`。

建议：

- 生产环境建议启用 `PANEL_AUTH_TOKEN` 并设置强随机密码。
- 挂载 `./data:/data` 保留 Web 配置。
- 不要把真实 `TUNNEL_TOKEN` 提交到 Git 或公开仓库。

## 故障排查

查看日志：

```bash
docker logs -f cloudflare-tunnel-panel
```

确认面板健康：

```bash
curl -i http://127.0.0.1:18088/health
```

确认公网探测地址：

```bash
curl -i https://你的域名/health
```

如果日志里看到：

```text
Registered tunnel connection
```

说明 `cloudflared` 已经连接 Cloudflare。

如果看到外部探测 `404`、`401`、`403` 或超时，请检查：

- 外部探测 URL 是否真实存在。
- Cloudflare 路由配置是否指向正确源站。
- Service 是否误写成 `https://`。
- 接受状态码是否符合你的服务返回。

如果手动停止 Tunnel，面板不会自动重连；再次点击启动或重连即可恢复。
