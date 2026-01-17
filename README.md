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
  - 一键安装 Vanilla / Paper（弹窗配置：版本/内存/端口/Java/FRP 等，带安装日志）
  - Start/Stop/Restart/Console/Delete
  - Socket 显示与复制：FRP 显示公网连接地址；不使用 FRP 显示本机/LAN IP:Port
  - 实例配置持久化：`servers/<instance_id>/.elegantmc.json`（jar/java/内存/端口/FRP）
- **FRP**
  - 保存/复用 FRP Server（addr/port/token）
  - 在线探测（TCP connect，带延迟/错误信息）
- **Files**
  - `servers/` 沙箱内文件浏览/编辑
  - 删除文件/目录（递归删除，带确认）
  - 大文件分片上传（mods/plugins/jar 等）
  - 日志在 Games 页直接查看（MC/Install/FRP）

## 目录结构

- `daemon/`：Go Daemon（本地节点）
- `panel/`：Next.js Web Panel（自建 Node server）
- `docker-compose.yml`：本机一键体验（Panel + Daemon 同机）

## Docker 一键启动（推荐）

### 1) 启动（默认无需 `.env`）

```bash
docker compose up -d --build
```

然后访问 `http://127.0.0.1:3000`。

> 默认会创建一个本地节点：`daemon_id=local-node`、`token=local-dev-token`（仅用于本机体验，生产环境务必修改）。

如果你没有设置 `ELEGANTMC_PANEL_ADMIN_PASSWORD`，Panel 会在启动日志里生成一个随机密码：

```bash
docker compose logs panel
```

你也可以直接用环境变量覆盖（无需 `.env`）：

```bash
ELEGANTMC_PANEL_ADMIN_PASSWORD='change-me' \
ELEGANTMC_DAEMON_ID='home-1' \
ELEGANTMC_TOKEN='your-strong-token' \
docker compose up -d --build
```

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

## DockerHub 镜像一键启动（无需 build）

适用于你已经把镜像发布到 DockerHub（或其他 registry）的场景。

1) 启动（默认使用 `ign1x/*:latest`）：

```bash
docker compose -f docker-compose.images.yml up -d
```

2) 覆盖 tag / 管理员密码（示例）：

```bash
ELEGANTMC_IMAGE_TAG='v1.0.0' \
ELEGANTMC_PANEL_ADMIN_PASSWORD='change-me' \
docker compose -f docker-compose.images.yml up -d
```

### 数据持久化

Docker 默认使用两个 volume：

- `elegantmc-data`：Daemon 数据（包含 `servers/`、`bin/`、FRP 工作目录等）
- `elegantmc-panel-data`：Panel 数据（节点 token 与 FRP profiles）

## 真实部署建议（公网 Panel + 家用 Daemon）

> 目标：Panel 在公网（VPS），Daemon 在家用机器无公网 IP，通过出站 WebSocket 连接；FRP 用于给朋友公网直连。

### 1) 在 VPS 部署 Panel（建议 Docker + HTTPS）

- 建议用反向代理（Nginx/Caddy）提供 HTTPS，并转发 WebSocket（Upgrade）。
- Panel 环境变量：
  - `ELEGANTMC_PANEL_ADMIN_PASSWORD`：管理员密码（必填）
  - `ELEGANTMC_PANEL_SECURE_COOKIE=1`：仅当通过 HTTPS 访问时开启（否则浏览器不会发 Secure Cookie）
- WS 地址：`wss://<your-panel-domain>/ws/daemon`

> 注意：Panel 是单管理员密码登录（Cookie 会话）。公网部署务必使用 HTTPS，否则登录 Cookie 容易被劫持。

### 2) 在家用机器部署 Daemon（无公网 IP）

Daemon 只需要出站访问你的 Panel（无需端口映射/公网 IP）。常用环境变量：

- `ELEGANTMC_PANEL_WS_URL=wss://<your-panel-domain>/ws/daemon`
- `ELEGANTMC_DAEMON_ID=<your-node-id>`
- `ELEGANTMC_TOKEN=<token>`（在 Panel 的 Nodes 页面创建/复制）

### 3) 连接地址显示（Socket）

如果你的部署环境比较复杂（例如 Daemon 跑在 Docker 里，或多网卡），可以在 Daemon 侧显式指定对外连接地址：

- `ELEGANTMC_PREFERRED_CONNECT_ADDRS=192.168.1.10,mc.example.com`

Panel 会优先用这个地址来展示 “Socket”（不影响实际监听端口）。

## FRP 使用指南（推荐）

### 1) 在 VPS 上跑 `frps`

需要开放：

- `bindPort`（例如 7000）给 `frpc` 连接
- 你计划分配给 MC 的 `remote_port`（例如 25566/25567/...），或按 frps 策略放行一个端口段

### 2) 在 Panel 保存 FRP Server

在 FRP 标签页点击 Add，填写：

- `Server Addr`：你的 frps 域名/IP
- `Server Port`：bindPort（例如 7000）
- `Token`：frps token（如有）

### 3) 在 Games 启用 FRP 并启动

在 Settings 里开启 FRP，选择上面保存的服务器，并设置 `FRP Remote Port`（例如 25566）。

启动后，Games 页的 “Socket” 会显示公网地址（可复制给朋友）。

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
- 也可在 Games → Settings 里填写 `Java (optional)`（会写入 `.elegantmc.json`，后续启动自动携带）

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
