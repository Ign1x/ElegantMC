# ElegantMC

ElegantMC 是一个「公网 Web Panel + 本地 Daemon」的 Minecraft 开服与远程管理方案，重点解决：

- 国内大量用户无公网 IP：Daemon 主动 **WebSocket 出站连接**到公网 Panel（无需端口映射/公网 IP）。
- 一键 FRP：Panel 保存 FRP Server（addr/port/token）；Daemon 自动生成配置并托管 `frpc` 子进程。
- 安全隔离：Daemon 默认只允许访问自身工作目录下的 `servers/`（沙箱），避免变成“肉鸡”。

## 当前功能（MVP）

- **Nodes**
  - 节点添加/删除（`daemon_id → token` 映射持久化到 Panel 数据目录）
  - 在线状态、CPU/内存概览
  - Node Details：性能曲线（CPU/MEM）+ instances 列表
- **Games**
  - 选择已安装的游戏实例（`servers/<instance_id>` 目录）
  - 一键安装 Vanilla（弹窗配置：版本/内存/端口/FRP 等，带安装日志）
  - Start/Stop/Restart/Console/Delete
  - Socket 显示与复制：FRP 显示公网连接地址；不使用 FRP 显示本机/LAN IP:Port
- **FRP**
  - 保存/复用 FRP Server（addr/port/token）
  - 在线探测（TCP connect，带延迟/错误信息）
- **Files**
  - `servers/` 沙箱内文件浏览/编辑
  - 大文件分片上传（mods/plugins/jar 等）
  - 日志在 Games 页直接查看（MC/Install/FRP）

## 目录结构

- `daemon/`：Go Daemon（本地节点）
- `panel/`：Next.js Web Panel（自建 Node server）
- `docker-compose.yml`：本机一键体验（Panel + Daemon 同机）

## Docker 一键启动（推荐）

### 1) 配置 `.env`

```bash
cp .env.example .env
```

至少需要设置：

- `ELEGANTMC_DAEMON_ID`：节点 ID（例如 `home-1`）
- `ELEGANTMC_TOKEN`：节点 token（任意随机字符串也行）
- `ELEGANTMC_PANEL_ADMIN_PASSWORD`：Panel 管理员密码（用于 Web 登录）

### 2) 启动

```bash
docker compose up -d --build
```

然后访问 `http://127.0.0.1:3000`。

> 直连端口：`docker-compose.yml` 默认把 Daemon 容器的 `25565-25600` 映射到宿主机同端口（方便在 Panel 里调整 Game Port 并从本机/LAN 直连）。

### 国内网络加速（可选）

- `NPM_REGISTRY`：例如 `https://registry.npmmirror.com`
- `GOPROXY`：例如 `https://goproxy.cn,direct`
- Mojang 镜像（BMCLAPI 等）：
  - `ELEGANTMC_MOJANG_META_BASE_URL`
  - `ELEGANTMC_MOJANG_DATA_BASE_URL`

如果遇到 BuildKit 拉取失败，可用：

```bash
DOCKER_BUILDKIT=0 docker compose up -d --build
```

### 数据持久化

Docker 默认使用两个 volume：

- `elegantmc-data`：Daemon 数据（包含 `servers/`、`bin/`、FRP 工作目录等）
- `elegantmc-panel-data`：Panel 数据（节点 token 与 FRP profiles）

## 真实部署建议（公网 Panel + 家用 Daemon）

1) 把 `panel/` 部署到公网 VPS（建议挂 TLS，提供 `wss://`）。
2) 家用机器只跑 Daemon（可用 Docker），并设置：
   - `ELEGANTMC_PANEL_WS_URL=wss://<your-panel>/ws/daemon`
   - `ELEGANTMC_DAEMON_ID=<your-node-id>`
   - `ELEGANTMC_TOKEN=<token>`（在 Panel 的 Nodes 页面生成/保存）
3) Panel 建议启用 HTTPS，并设置：
   - `ELEGANTMC_PANEL_SECURE_COOKIE=1`（只在 HTTPS 下使用 Secure Cookie）

> 注意：当前 Panel 是单管理员密码登录（Cookie 会话）。公网部署务必使用 HTTPS，否则登录 Cookie 容易被劫持。

## Java 自动选择（重要）

Minecraft 新版本会要求更高的 Java（例如 class file 65 对应 Java 21）。Daemon 在 `mc_start` 时会：

1) 读取 `server.jar` 的 `MANIFEST.MF`（`Main-Class`），定位入口 `.class`；
2) 读取该 class 的 classfile major version，推断最低 **Java major**；
3) 从 `ELEGANTMC_JAVA_CANDIDATES` 中选择 **最小的满足版本** 的 Java 来启动（通常更兼容）。

配置方式：

- `ELEGANTMC_JAVA_CANDIDATES`：逗号分隔，可写多个可执行路径或命令名，例如：
  - `ELEGANTMC_JAVA_CANDIDATES=java,/opt/jdk17/bin/java,/opt/jdk21/bin/java`

手动指定：

- `mc_start` 支持 `java_path` 参数（可通过 Panel 的 Advanced 标签手动下发）。

Docker 的 Daemon 运行镜像默认内置 **Java 21**。

## 开发运行（不使用 Docker）

### Panel

```bash
cd panel
npm install
cp .env.example .env
npm run dev
```

默认监听 `http://0.0.0.0:3000`，Daemon WS 入口：`ws://127.0.0.1:3000/ws/daemon`。

### Daemon

需要 Go（建议 1.22+）：

```bash
cd daemon
go mod download
go test ./...
go build -o ../daemon-bin ./cmd/elegantmc-daemon
```

运行（token 与 Panel Nodes 中保存的 token 保持一致）：

```bash
ELEGANTMC_PANEL_WS_URL="ws://127.0.0.1:3000/ws/daemon" \
ELEGANTMC_TOKEN="devtoken123" \
ELEGANTMC_DAEMON_ID="my-node" \
ELEGANTMC_BASE_DIR="$PWD/.elegantmc" \
../daemon-bin
```

## Troubleshooting

- `UnsupportedClassVersionError (class file version 65)`：需要 Java 21。
  - Docker：已内置 Java 21；
  - 非 Docker：安装 Java 21 并设置 `ELEGANTMC_JAVA_CANDIDATES`，或在 `mc_start` 里传 `java_path`。
- Vanilla 下载失败（国内）：设置 `ELEGANTMC_MOJANG_META_BASE_URL` / `ELEGANTMC_MOJANG_DATA_BASE_URL` 为国内镜像（如 BMCLAPI）。

## 安全注意事项（必读）

- Panel 使用 `ELEGANTMC_PANEL_ADMIN_PASSWORD` 做单管理员登录（Cookie 会话）；公网部署务必使用 HTTPS。
- Daemon 与 Panel 的配对依赖 `daemon_id → token`；token 请当作密钥管理。
