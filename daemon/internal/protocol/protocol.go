package protocol

import "encoding/json"

// Message is the minimal envelope exchanged between Panel and Daemon.
// All messages are JSON-encoded.
type Message struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	TSUnix  int64           `json:"ts_unix,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Hello is sent by the daemon after connect.
type Hello struct {
	DaemonID string   `json:"daemon_id"`
	Version  string   `json:"version"`
	OS       string   `json:"os"`
	Arch     string   `json:"arch"`
	Features []string `json:"features,omitempty"`
}

// Heartbeat is sent periodically by the daemon.
type Heartbeat struct {
	DaemonID   string            `json:"daemon_id"`
	UptimeSec  int64             `json:"uptime_sec"`
	Tags       map[string]string `json:"tags,omitempty"`
	FRP        *FRPStatus        `json:"frp,omitempty"`
	Instances  []MCInstance      `json:"instances,omitempty"`
	CPU        *CPUStat          `json:"cpu,omitempty"`
	Mem        *MemStat          `json:"mem,omitempty"`
	Disk       *DiskStat         `json:"disk,omitempty"`
	Net        *NetInfo          `json:"net,omitempty"`
	LastError  string            `json:"last_error,omitempty"`
	ServerTime int64             `json:"server_time_unix,omitempty"`
}

type CPUStat struct {
	UsagePercent float64 `json:"usage_percent"`
}

type MemStat struct {
	TotalBytes uint64 `json:"total_bytes"`
	UsedBytes  uint64 `json:"used_bytes"`
	FreeBytes  uint64 `json:"free_bytes"`
}

type DiskStat struct {
	Path       string `json:"path"`
	TotalBytes uint64 `json:"total_bytes"`
	UsedBytes  uint64 `json:"used_bytes"`
	FreeBytes  uint64 `json:"free_bytes"`
}

type NetInfo struct {
	Hostname string   `json:"hostname,omitempty"`
	IPv4     []string `json:"ipv4,omitempty"`
	PreferredConnectAddrs []string `json:"preferred_connect_addrs,omitempty"`
}

type FRPStatus struct {
	Running     bool   `json:"running"`
	ProxyName   string `json:"proxy_name,omitempty"`
	RemoteAddr  string `json:"remote_addr,omitempty"`
	RemotePort  int    `json:"remote_port,omitempty"`
	StartedUnix int64  `json:"started_unix,omitempty"`
}

type MCInstance struct {
	ID      string `json:"id"`
	Running bool   `json:"running"`
	PID     int    `json:"pid,omitempty"`
}

// Command is sent by the panel to ask the daemon to do something.
type Command struct {
	Name string                 `json:"name"`
	Args map[string]any         `json:"args,omitempty"`
	Meta map[string]interface{} `json:"meta,omitempty"`
}

// CommandResult is sent back by the daemon.
type CommandResult struct {
	OK     bool                   `json:"ok"`
	Output map[string]any         `json:"output,omitempty"`
	Error  string                 `json:"error,omitempty"`
	Meta   map[string]interface{} `json:"meta,omitempty"`
}

// LogLine streams process output (mc/frp) to the panel.
type LogLine struct {
	Source   string `json:"source"` // "mc" | "frp"
	Stream   string `json:"stream"` // "stdout" | "stderr"
	Instance string `json:"instance,omitempty"`
	Line     string `json:"line"`
}
