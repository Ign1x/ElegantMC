# ElegantMC Panel <-> Daemon 协议（v0.1）

## WebSocket 连接

Daemon 主动连接 Panel 的 WebSocket：

- URL：`ELEGANTMC_PANEL_WS_URL`
- Header：
  - `Authorization: Bearer <token>`（`ELEGANTMC_TOKEN`）
  - `X-ElegantMC-Daemon: <daemon_id>`

## 通用 Envelope

所有消息使用统一 Envelope：

```json
{
  "type": "hello|heartbeat|command|command_result|log",
  "id": "optional-correlation-id",
  "ts_unix": 1730000000,
  "payload": {}
}
```

`command` / `command_result` 的 `id` 用于关联请求与响应。

## Daemon -> Panel

### `hello`

```json
{
  "type": "hello",
  "payload": {
    "daemon_id": "my-node",
    "version": "0.1.0",
    "os": "linux",
    "arch": "amd64",
    "features": ["fs", "mc", "frp"]
  }
}
```

### `heartbeat`

```json
{
  "type": "heartbeat",
  "payload": {
    "daemon_id": "my-node",
    "uptime_sec": 123,
    "last_error": "",
    "server_time_unix": 1730000000,
    "frp": {
      "running": true,
      "proxy_name": "mc",
      "remote_addr": "frp.example.com",
      "remote_port": 25566,
      "started_unix": 1730000000
    },
    "cpu": {"usage_percent": 12.3},
    "mem": {"total_bytes": 17179869184, "used_bytes": 4294967296, "free_bytes": 12884901888},
    "disk": {"path": "/data", "total_bytes": 107374182400, "used_bytes": 123456789, "free_bytes": 107250725611},
    "net": {"hostname": "my-host", "ipv4": ["192.168.1.10"], "preferred_connect_addrs": ["192.168.1.10", "mc.example.com"]},
    "instances": [
      {"id": "server1", "running": true, "pid": 12345}
    ]
  }
}
```

### `command_result`

```json
{
  "type": "command_result",
  "id": "cmd-001",
  "payload": {
    "ok": true,
    "output": {"k": "v"},
    "error": ""
  }
}
```

### `log`

用于推送 `mc` / `frp` 的 stdout/stderr 行：

```json
{
  "type": "log",
  "payload": {
    "source": "mc|frp|install",
    "stream": "stdout|stderr",
    "instance": "server1",
    "line": "...."
  }
}
```

## Panel -> Daemon

### `command`

```json
{
  "type": "command",
  "id": "cmd-001",
  "payload": {
    "name": "mc_start",
    "args": {
      "instance_id": "server1",
      "jar_path": "server.jar",
      "xmx": "2G",
      "xms": "1G"
    }
  }
}
```

## 支持的命令（当前）

> 约束：`instance_id` 目前仅允许 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`（防止路径注入）。

### `ping`

返回 `{"pong": true}`。

### `fs_read`

读取 `servers` 根目录下文件（Base64）：

- args: `{ "path": "server1/server.properties" }`

### `fs_write`

写入 `servers` 根目录下文件（Base64）：

- args: `{ "path": "server1/server.properties", "b64": "..." }`

### `fs_upload_begin`

为大文件/二进制文件（mods/plugins/jar 等）开启一个分片上传会话：

- args: `{ "path": "server1/plugins/SomePlugin.jar" }`
- output: `{ "upload_id": "...", "path": "server1/plugins/SomePlugin.jar" }`

### `fs_upload_chunk`

上传一个分片（Base64）。Daemon 侧限制：单分片解码后最大 512KB；单文件最大 512MB。

- args: `{ "upload_id": "...", "b64": "..." }`
- output: `{ "upload_id": "...", "bytes": 123456 }`（累计已写入字节数）

### `fs_upload_commit`

提交上传并原子替换目标文件（写入 `.partial` 后 `rename`）：

- args: `{ "upload_id": "...", "sha256": "optional" }`
- output: `{ "path": "server1/plugins/SomePlugin.jar", "bytes": 123456, "sha256": "..." }`

### `fs_upload_abort`

中止上传并清理临时文件：

- args: `{ "upload_id": "..." }`

### `fs_list`

列目录：

- args: `{ "path": "server1" }`

### `fs_delete`

删除文件/目录（递归），路径必须在 `servers` 根目录下：

- args: `{ "path": "server1/plugins/SomePlugin.jar" }`
- output: `{ "path": "...", "deleted": true, "is_dir": false }`

### `fs_download`

下载文件到 `servers` 根目录下（用于安装 server.jar / plugins / mods 等）：

- args:
  - `path`: 目标路径（如 `server1/server.jar`）
  - `url`: http/https 下载地址
  - `sha256`: 可选，校验用
  - `sha1`: 可选，校验用

### `mc_start`

启动 MC 实例（当前为本机进程模式）：

- args:
  - `instance_id`: `server1`
  - `jar_path`: `server.jar`（相对 `servers/<instance_id>/`）
  - `java_path`: 可选。指定要使用的 `java` 可执行路径/命令名；不填则 Daemon 自动从 jar 推断最低 Java 并在候选列表中选择
  - `xms` / `xmx`: 例如 `1G` / `2G`

### `mc_stop`

- args: `{ "instance_id": "server1" }`

### `mc_restart`

重启（等价于 `mc_stop` 后 `mc_start`，参数同 `mc_start`）：

- args: 同 `mc_start`

### `mc_console`

向实例 stdin 写入一行（例如 `say hi`）：

- args: `{ "instance_id": "server1", "line": "say hi" }`

### `mc_delete`

删除一个实例目录（`servers/<instance_id>`）。Daemon 会先 best-effort 停止进程，再执行删除：

- args: `{ "instance_id": "server1" }`

### `frp_start`

启动 `frpc`（Daemon 托管进程）：

- args:
  - `name`: `mc`
  - `server_addr`: `frp.example.com`
  - `server_port`: `7000`
  - `token`: `...`（可选）
  - `local_ip`: `127.0.0.1`（可选）
  - `local_port`: `25565`
  - `remote_port`: `25566`（0 表示不写入该项，由 frp 服务端策略决定）

### `frp_stop`

停止 `frpc`。

### `frpc_install`

下载/更新 `frpc` 二进制到 Daemon 配置的固定路径（`ELEGANTMC_FRPC_PATH`）。该命令不允许自定义目标路径。

- args:
  - `url`: http/https 下载地址
  - `sha256`: 可选，校验用

## 安装类命令（当前）

### `mc_install_vanilla`

根据 Mojang 版本清单解析并下载 Vanilla 服务端 jar：

- args:
  - `instance_id`: `server1`
  - `version`: 例如 `1.20.1`
  - `jar_name`: 可选（默认 `server.jar`）
  - `accept_eula`: 可选（true 则写入 `eula.txt`）

返回：
- `jar_path`: `server.jar`（相对 `servers/<instance_id>/`）
- `path`: `server1/server.jar`（相对 `servers/` 根）

### `mc_install_paper`

通过 Paper API 下载 Paper 服务端 jar（默认最新 build）：

- args:
  - `instance_id`: `server1`
  - `version`: 例如 `1.20.1`
  - `build`: 可选（0 或不填表示最新）
  - `jar_name`: 可选（默认 `server.jar`）
  - `accept_eula`: 可选（true 则写入 `eula.txt`）
