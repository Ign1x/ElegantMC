# ElegantMC Daemon (Go)

Daemon 是被控端节点，负责：

- 主动连接 Panel（WSS/WebSocket），周期性发送心跳（含 CPU/Mem/Disk + 实例状态）；
- 接收 Panel 下发的命令并执行（安装/启动/停止/控制台、FRP 托管、文件读写与上传等）；
- 默认严格限制文件系统访问在 `base_dir/servers` 下（沙箱）。

协议见 `daemon/PROTOCOL.md`。

## 配置（环境变量）

必填：

- `ELEGANTMC_PANEL_WS_URL`：例如 `wss://panel.example.com/ws/daemon`
- `ELEGANTMC_TOKEN`：Panel 保存的 token

常用：

- `ELEGANTMC_BASE_DIR`：Daemon 工作目录（默认：当前目录）
- `ELEGANTMC_DAEMON_ID`：节点 ID（默认：hostname）
- `ELEGANTMC_HEARTBEAT_SEC`：心跳间隔秒（默认：10）
- `ELEGANTMC_PREFERRED_CONNECT_ADDRS`：逗号分隔的对外连接地址（可选），会在 heartbeat 里上报给 Panel 用于展示「Socket」（例如 `192.168.1.10` 或 `mc.example.com`）

Java（自动选择）：

- `ELEGANTMC_JAVA_CANDIDATES`：逗号分隔的 Java 可执行（路径或命令名），默认 `java`
  - Daemon 会从 `server.jar` 推断最低 Java major，然后选择 **最小满足版本** 的 Java 启动
  - 也可在 `mc_start` args 里手动传 `java_path`

Java（自动下载，可选）：

- `ELEGANTMC_JAVA_AUTO_DOWNLOAD`：是否允许自动下载 Temurin JRE（默认 `1`）
- `ELEGANTMC_JAVA_CACHE_DIR`：下载缓存目录（默认：`base_dir/java`）
- `ELEGANTMC_JAVA_ADOPTIUM_API_BASE_URL`：Adoptium API（默认 `https://api.adoptium.net`）

FRP：

- `ELEGANTMC_FRPC_PATH`：`frpc` 可执行文件路径（默认：`base_dir/bin/frpc` 或 `frpc.exe`）
- `ELEGANTMC_FRP_WORK_DIR`：FRP 工作目录（默认：`base_dir/frp`）

Scheduler（定时任务，可选）：

- `ELEGANTMC_SCHEDULE_ENABLED`：是否启用（默认 `1`）
- `ELEGANTMC_SCHEDULE_FILE`：任务文件路径（默认：`base_dir/schedule.json`）
- `ELEGANTMC_SCHEDULE_POLL_SEC`：轮询/执行间隔（默认 `30`）

`schedule.json` 示例：

```json
{
  "tasks": [
    { "id": "restart-server1", "type": "restart", "instance_id": "server1", "every_sec": 86400 },
    { "id": "backup-server1", "type": "backup", "instance_id": "server1", "every_sec": 86400, "keep_last": 7 },
    { "id": "stop-server1", "type": "stop", "instance_id": "server1", "every_sec": 86400 },
    { "id": "announce-server1", "type": "announce", "instance_id": "server1", "every_sec": 86400, "message": "Server will restart in 5 minutes" },
    { "id": "prune-logs-server1", "type": "prune_logs", "instance_id": "server1", "every_sec": 86400, "keep_last": 30 }
  ]
}
```

说明：

- `restart` 会读取 `servers/<instance>/.elegantmc.json` 作为启动参数（jar/java/xms/xmx）
- `stop` 会停止实例进程（若未运行则忽略）
- `backup` 会输出 zip 到 `servers/_backups/<instance>/`
- `announce` 会向实例控制台发送 `say <message>`
- `prune_logs` 会清理 `servers/<instance>/logs/` 目录下更旧的文件（保留 `keep_last` 个）

镜像/下载源（可选）：

- `ELEGANTMC_MOJANG_META_BASE_URL`：默认 `https://piston-meta.mojang.com`（国内可改成 BMCLAPI）
- `ELEGANTMC_MOJANG_DATA_BASE_URL`：默认 `https://piston-data.mojang.com`（国内可改成 BMCLAPI）
- `ELEGANTMC_PAPER_API_BASE_URL`：默认 `https://api.papermc.io`

## 运行（示例）

```bash
ELEGANTMC_PANEL_WS_URL="wss://example.com/ws/daemon" \
ELEGANTMC_TOKEN="xxxx" \
ELEGANTMC_DAEMON_ID="home-1" \
ELEGANTMC_BASE_DIR="$HOME/elegantmc" \
./elegantmc-daemon
```
