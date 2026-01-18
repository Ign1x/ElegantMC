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
	"sort"
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
	proxies map[string]*proxyProc
}

type proxyProc struct {
	started time.Time
	proxy   ProxyConfig

	cmd    *exec.Cmd
	cancel context.CancelFunc
	done   chan error
}

func NewManager(cfg ManagerConfig) *Manager {
	return &Manager{cfg: cfg, proxies: make(map[string]*proxyProc)}
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
	list := m.Statuses()
	for _, st := range list {
		if st.Running {
			return st
		}
	}
	return Status{Running: false}
}

func (m *Manager) Statuses() []Status {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make([]Status, 0, len(m.proxies))
	for name, p := range m.proxies {
		if p == nil || p.cmd == nil || p.cmd.Process == nil {
			continue
		}
		out = append(out, Status{
			Running:     true,
			ProxyName:   name,
			RemoteAddr:  p.proxy.ServerAddr,
			RemotePort:  p.proxy.RemotePort,
			StartedUnix: p.started.Unix(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ProxyName < out[j].ProxyName })
	return out
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

	// restart this proxy if already running
	if prev := m.proxies[proxy.Name]; prev != nil {
		_ = m.stopLocked(context.Background(), prev)
	}

	proxyWorkDir := filepath.Join(m.cfg.WorkDir, proxy.Name)
	if err := os.MkdirAll(proxyWorkDir, 0o755); err != nil {
		return err
	}
	ini, err := GenerateINI(proxy)
	if err != nil {
		return err
	}

	iniPath := filepath.Join(proxyWorkDir, "frpc.ini")
	if err := os.WriteFile(iniPath, []byte(ini), 0o600); err != nil {
		return err
	}

	cmdCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(cmdCtx, m.cfg.FRPCPath, "-c", iniPath)
	cmd.Dir = proxyWorkDir

	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		cancel()
		return err
	}

	done := make(chan error, 1)

	name := proxy.Name
	proc := &proxyProc{
		cmd:     cmd,
		cancel:  cancel,
		done:    done,
		started: time.Now(),
		proxy:   proxy,
	}
	m.proxies[name] = proc

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

		// If a new proc has been started for this name, don't clobber it.
		if cur := m.proxies[name]; cur == proc {
			delete(m.proxies, name)
			if cur.cancel != nil {
				cur.cancel()
				cur.cancel = nil
			}
		}
		if err != nil && m.cfg.Log != nil {
			m.cfg.Log.Printf("frpc exited (%s): %v", name, err)
		}
	}()

	if m.cfg.Log != nil {
		m.cfg.Log.Printf("frpc started: %s -> %s:%d (remote_port=%d)", proxy.Name, proxy.ServerAddr, proxy.ServerPort, proxy.RemotePort)
	}

	return nil
}

func (m *Manager) Stop(ctx context.Context) error {
	return m.StopAll(ctx)
}

func (m *Manager) StopAll(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	var firstErr error
	for name, p := range m.proxies {
		if p == nil {
			delete(m.proxies, name)
			continue
		}
		if err := m.stopLocked(ctx, p); err != nil && firstErr == nil {
			firstErr = err
		}
		delete(m.proxies, name)
	}
	return firstErr
}

func (m *Manager) StopProxy(ctx context.Context, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return errors.New("name is required")
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	p := m.proxies[name]
	if p == nil {
		return nil
	}

	if err := m.stopLocked(ctx, p); err != nil {
		return err
	}
	delete(m.proxies, name)
	return nil
}

func (m *Manager) stopLocked(ctx context.Context, p *proxyProc) error {
	if p == nil {
		return nil
	}
	if p.cancel != nil {
		p.cancel()
	}

	if p.cmd == nil || p.cmd.Process == nil {
		return nil
	}

	done := p.done
	if done == nil {
		// Shouldn't happen, but avoid panic.
		_ = p.cmd.Process.Kill()
		return nil
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(3 * time.Second):
		_ = p.cmd.Process.Kill()
		<-done
		return nil
	case <-done:
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
