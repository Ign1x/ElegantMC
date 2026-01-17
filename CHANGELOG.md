# CHANGELOG

## v1.0.0 (2026-01-17)

**Highlights**

- Panel（Next.js + 自建 Node server）：Nodes / Games / FRP / Files 管理、安装与日志查看
- Daemon（Go）：出站 WebSocket 连接、沙箱文件系统、Minecraft 进程管理、FRP `frpc` 托管
- Docker：`panel`/`daemon` 镜像、健康检查、支持 GitHub Actions 自动推送 DockerHub（多架构）

**Security**

- Daemon 可绑定首次连接的 Panel（`panel_id` 绑定，防止被多个 Panel 认领）
- Nodes/FRP 列表接口默认不返回明文 token（复制时通过受控 endpoint 获取）
- `frpc_install` 强制要求 `sha256` 校验

**Upgrade notes**

- 建议公网部署使用 HTTPS，并开启 `ELEGANTMC_PANEL_SECURE_COOKIE=1`（仅 HTTPS）
- 默认不建议启用 `ELEGANTMC_ENABLE_ADVANCED`

