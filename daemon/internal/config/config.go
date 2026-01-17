package config

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

type Config struct {
	PanelWSURL   string
	Token        string
	BaseDir      string
	DaemonID     string
	HeartbeatSec int

	FRPCPath   string
	FRPWorkDir string

	JavaCandidates []string
	PreferredConnectAddrs []string

	MojangMetaBaseURL string
	MojangDataBaseURL string
	PaperAPIBaseURL   string
}

func LoadFromEnv() (Config, error) {
	var cfg Config

	cfg.PanelWSURL = strings.TrimSpace(os.Getenv("ELEGANTMC_PANEL_WS_URL"))
	cfg.Token = strings.TrimSpace(os.Getenv("ELEGANTMC_TOKEN"))
	cfg.BaseDir = strings.TrimSpace(os.Getenv("ELEGANTMC_BASE_DIR"))
	cfg.DaemonID = strings.TrimSpace(os.Getenv("ELEGANTMC_DAEMON_ID"))

	if cfg.BaseDir == "" {
		cfg.BaseDir = "."
	}

	if cfg.DaemonID == "" {
		host, _ := os.Hostname()
		if host == "" {
			host = "unknown-host"
		}
		cfg.DaemonID = host
	}

	cfg.HeartbeatSec = 10
	if v := strings.TrimSpace(os.Getenv("ELEGANTMC_HEARTBEAT_SEC")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 3600 {
			return Config{}, errors.New("ELEGANTMC_HEARTBEAT_SEC must be an int in [1,3600]")
		}
		cfg.HeartbeatSec = n
	}

	cfg.FRPWorkDir = strings.TrimSpace(os.Getenv("ELEGANTMC_FRP_WORK_DIR"))
	if cfg.FRPWorkDir == "" {
		cfg.FRPWorkDir = filepath.Join(cfg.BaseDir, "frp")
	}

	cfg.FRPCPath = strings.TrimSpace(os.Getenv("ELEGANTMC_FRPC_PATH"))
	if cfg.FRPCPath == "" {
		cfg.FRPCPath = filepath.Join(cfg.BaseDir, "bin", defaultFRPCBinaryName())
	}

	cfg.JavaCandidates = splitListEnv(os.Getenv("ELEGANTMC_JAVA_CANDIDATES"))
	if len(cfg.JavaCandidates) == 0 {
		cfg.JavaCandidates = []string{"java"}
	}

	cfg.PreferredConnectAddrs = splitListEnv(os.Getenv("ELEGANTMC_PREFERRED_CONNECT_ADDRS"))

	cfg.MojangMetaBaseURL = strings.TrimSpace(os.Getenv("ELEGANTMC_MOJANG_META_BASE_URL"))
	if cfg.MojangMetaBaseURL == "" {
		cfg.MojangMetaBaseURL = "https://piston-meta.mojang.com"
	}
	cfg.MojangDataBaseURL = strings.TrimSpace(os.Getenv("ELEGANTMC_MOJANG_DATA_BASE_URL"))
	if cfg.MojangDataBaseURL == "" {
		cfg.MojangDataBaseURL = "https://piston-data.mojang.com"
	}
	cfg.PaperAPIBaseURL = strings.TrimSpace(os.Getenv("ELEGANTMC_PAPER_API_BASE_URL"))
	if cfg.PaperAPIBaseURL == "" {
		cfg.PaperAPIBaseURL = "https://api.papermc.io"
	}

	if cfg.PanelWSURL == "" {
		return Config{}, errors.New("ELEGANTMC_PANEL_WS_URL is required")
	}
	if cfg.Token == "" {
		return Config{}, errors.New("ELEGANTMC_TOKEN is required")
	}

	return cfg, nil
}

func defaultFRPCBinaryName() string {
	if runtime.GOOS == "windows" {
		return "frpc.exe"
	}
	return "frpc"
}

func (c Config) ServersRoot() string {
	return filepath.Join(c.BaseDir, "servers")
}

func splitListEnv(v string) []string {
	var out []string
	for _, part := range strings.Split(v, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		out = append(out, part)
	}
	return out
}
