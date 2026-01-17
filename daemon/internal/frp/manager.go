package frp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type ManagerConfig struct {
	FRPCPath string
	WorkDir  string
	Log      *log.Logger
}

type Manager struct {
	cfg ManagerConfig

	mu      sync.Mutex
	running bool
	started time.Time
	proxy   ProxyConfig

	cmd    *exec.Cmd
	cancel context.CancelFunc
	done   chan error
}

func NewManager(cfg ManagerConfig) *Manager {
	return &Manager{cfg: cfg}
}

type ProxyConfig struct {
	Name       string `json:"name"`
	ServerAddr string `json:"server_addr"`
	ServerPort int    `json:"server_port"`
	Token      string `json:"token,omitempty"`

	// tcp only for now
	LocalIP    string `json:"local_ip"`
	LocalPort  int    `json:"local_port"`
	RemotePort int    `json:"remote_port"`
}

type Status struct {
	Running     bool
	ProxyName   string
	RemoteAddr  string
	RemotePort  int
	StartedUnix int64
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()

	st := Status{
		Running: m.running,
	}
	if m.running {
		st.ProxyName = m.proxy.Name
		st.RemoteAddr = m.proxy.ServerAddr
		st.RemotePort = m.proxy.RemotePort
		st.StartedUnix = m.started.Unix()
	}
	return st
}

func (m *Manager) Start(ctx context.Context, proxy ProxyConfig, logSink func(stream, line string)) error {
	if strings.TrimSpace(proxy.Name) == "" {
		return errors.New("frp proxy name is required")
	}
	if proxy.ServerAddr == "" || proxy.ServerPort <= 0 {
		return errors.New("frp server_addr/server_port required")
	}
	if proxy.LocalIP == "" {
		proxy.LocalIP = "127.0.0.1"
	}
	if proxy.LocalPort <= 0 {
		return errors.New("frp local_port required")
	}
	if proxy.RemotePort < 0 {
		return errors.New("frp remote_port must be >= 0")
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// restart if running
	if m.running {
		_ = m.stopLocked(context.Background())
	}

	if err := os.MkdirAll(m.cfg.WorkDir, 0o755); err != nil {
		return err
	}
	ini, err := GenerateINI(proxy)
	if err != nil {
		return err
	}

	iniPath := filepath.Join(m.cfg.WorkDir, "frpc.ini")
	if err := os.WriteFile(iniPath, []byte(ini), 0o600); err != nil {
		return err
	}

	cmdCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(cmdCtx, m.cfg.FRPCPath, "-c", iniPath)
	cmd.Dir = m.cfg.WorkDir

	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		cancel()
		return err
	}

	done := make(chan error, 1)

	m.cmd = cmd
	m.cancel = cancel
	m.done = done
	m.running = true
	m.started = time.Now()
	m.proxy = proxy

	if stdout != nil {
		go streamLines(stdout, func(line string) {
			if logSink != nil {
				logSink("stdout", line)
			}
		})
	}
	if stderr != nil {
		go streamLines(stderr, func(line string) {
			if logSink != nil {
				logSink("stderr", line)
			}
		})
	}

	go func() {
		err := cmd.Wait()
		done <- err
		close(done)

		m.mu.Lock()
		defer m.mu.Unlock()
		m.running = false
		m.cmd = nil
		m.done = nil
		if m.cancel != nil {
			m.cancel()
			m.cancel = nil
		}
		if err != nil && m.cfg.Log != nil {
			m.cfg.Log.Printf("frpc exited: %v", err)
		}
	}()

	if m.cfg.Log != nil {
		m.cfg.Log.Printf("frpc started: %s -> %s:%d (remote_port=%d)", proxy.Name, proxy.ServerAddr, proxy.ServerPort, proxy.RemotePort)
	}

	return nil
}

func (m *Manager) Stop(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.stopLocked(ctx)
}

func (m *Manager) stopLocked(ctx context.Context) error {
	if !m.running {
		return nil
	}
	if m.cancel != nil {
		m.cancel()
	}
	if m.cmd == nil || m.cmd.Process == nil {
		m.running = false
		return nil
	}

	done := m.done
	if done == nil {
		// Shouldn't happen, but avoid panic.
		_ = m.cmd.Process.Kill()
		m.running = false
		return nil
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(3 * time.Second):
		_ = m.cmd.Process.Kill()
		<-done
		m.running = false
		return nil
	case <-done:
		m.running = false
		return nil
	}
}

func streamLines(r io.Reader, onLine func(string)) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		if onLine != nil {
			onLine(line)
		}
	}
}

func GenerateINI(p ProxyConfig) (string, error) {
	if strings.TrimSpace(p.Name) == "" {
		return "", errors.New("proxy name is required")
	}
	if p.ServerAddr == "" || p.ServerPort <= 0 {
		return "", errors.New("server_addr/server_port required")
	}
	if p.LocalIP == "" {
		p.LocalIP = "127.0.0.1"
	}
	if p.LocalPort <= 0 {
		return "", errors.New("local_port required")
	}

	var b strings.Builder
	b.WriteString("[common]\n")
	fmt.Fprintf(&b, "server_addr = %s\n", p.ServerAddr)
	fmt.Fprintf(&b, "server_port = %d\n", p.ServerPort)
	if p.Token != "" {
		fmt.Fprintf(&b, "token = %s\n", p.Token)
	}
	b.WriteString("log_level = info\n")
	b.WriteString("disable_log_color = true\n")
	b.WriteString("\n")
	fmt.Fprintf(&b, "[%s]\n", p.Name)
	b.WriteString("type = tcp\n")
	fmt.Fprintf(&b, "local_ip = %s\n", p.LocalIP)
	fmt.Fprintf(&b, "local_port = %d\n", p.LocalPort)
	if p.RemotePort > 0 {
		fmt.Fprintf(&b, "remote_port = %d\n", p.RemotePort)
	}
	return b.String(), nil
}
