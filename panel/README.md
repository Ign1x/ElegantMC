# ElegantMC Panel (Next.js)

Panel 是公网控制台，提供：

- WS 网关：`/ws/daemon`（Daemon 出站连接）
- Node 管理：`daemon_id → token` 映射持久化到 Panel 数据目录
- FRP profiles 保存/复用 + 在线探测
- Vanilla 版本列表代理（避免浏览器直连 Mojang 的 CORS/网络问题）
- 给 Daemon 下发命令 & 拉取日志

## 运行

```bash
npm install
cp .env.example .env
npm run dev
```

默认监听 `http://0.0.0.0:3000`。

## 登录/权限（重要）

Panel 使用单管理员密码登录（Cookie 会话）：

- `ELEGANTMC_PANEL_ADMIN_PASSWORD`：管理员密码（必填；为空则启动时自动生成并打印到日志）
- `ELEGANTMC_PANEL_SECURE_COOKIE=1`：仅当你通过 HTTPS 提供 Panel 时再开启（否则浏览器不会发送 Secure Cookie）

## 数据目录（重要）

Panel 会把数据写入 `ELEGANTMC_PANEL_DATA_DIR`（默认：`./.elegantmc-panel`）：

- `daemon_tokens.json`：Nodes（token 映射）
- `frp_profiles.json`：FRP 服务器 profiles

Docker 运行时默认挂载到 volume：见根目录 `docker-compose.yml`。

## 主要接口（MVP）

- `GET /api/daemons`：已知 Daemon 列表（含 heartbeat + history）
- `POST /api/daemons/:id/command`：下发命令（WS 转发）
- `GET /api/daemons/:id/logs`：拉取日志环形缓冲
- `GET/POST/DELETE /api/nodes`：管理 `daemon_id → token`
- `GET/POST/DELETE /api/frp/profiles`：管理 FRP profiles（GET 会附带 status）
- `GET /api/mc/versions`：Vanilla 版本列表（Panel 侧拉取并缓存）

## Modpacks（可选）

环境变量：

- `ELEGANTMC_MODRINTH_BASE_URL`（默认 `https://api.modrinth.com`）
- `ELEGANTMC_CURSEFORGE_BASE_URL`（默认 `https://api.curseforge.com`）
- `ELEGANTMC_CURSEFORGE_API_KEY`（CurseForge 必填）

主要接口：

- `GET /api/modpacks/providers`
- `GET /api/modpacks/search?provider=modrinth|curseforge&query=...`
- `GET /api/modpacks/modrinth/:projectId/versions`
- `GET /api/modpacks/curseforge/:modId/files`
- `GET /api/modpacks/curseforge/files/:fileId/download-url`
