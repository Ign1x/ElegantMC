package wsclient

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"elegantmc/daemon/internal/protocol"
	"nhooyr.io/websocket"
)

func jitter(max time.Duration) time.Duration {
	if max <= 0 {
		return 0
	}
	n, err := rand.Int(rand.Reader, big.NewInt(int64(max)))
	if err != nil {
		return 0
	}
	return time.Duration(n.Int64())
}

type CommandExecutor interface {
	BindSender(send func(msg protocol.Message))
	Execute(ctx context.Context, cmd protocol.Command) protocol.CommandResult
	HeartbeatSnapshot() protocol.Heartbeat
}

type Config struct {
	URL      string
	Token    string
	DaemonID string

	HealthFile string

	HeartbeatEvery time.Duration
	ReconnectMin   time.Duration
	ReconnectMax   time.Duration

	BindPanel        bool
	PanelBindingPath string

	Log             *log.Logger
	CommandExecutor CommandExecutor
}

type Client struct {
	cfg Config

	started time.Time
	lastErr atomicError

	writeMu sync.Mutex
	connMu  sync.RWMutex
	conn    *websocket.Conn

	bindMu      sync.Mutex
	boundPanelID string
}

func New(cfg Config) *Client {
	if cfg.HeartbeatEvery <= 0 {
		cfg.HeartbeatEvery = 10 * time.Second
	}
	if cfg.ReconnectMin <= 0 {
		cfg.ReconnectMin = 1 * time.Second
	}
	if cfg.ReconnectMax <= 0 {
		cfg.ReconnectMax = 30 * time.Second
	}
	c := &Client{cfg: cfg, started: time.Now()}
	if cfg.BindPanel && strings.TrimSpace(cfg.PanelBindingPath) != "" {
		if id, err := loadPanelBinding(cfg.PanelBindingPath); err == nil {
			c.boundPanelID = id
		}
	}
	return c
}

func (c *Client) Run(ctx context.Context) error {
	if c.cfg.CommandExecutor == nil {
		return errors.New("CommandExecutor is nil")
	}

	c.cfg.CommandExecutor.BindSender(func(msg protocol.Message) {
		_ = c.sendWithTimeout(ctx, msg, 5*time.Second)
	})

	c.writeHealth()
	go c.heartbeatLoop(ctx)

	backoff := c.cfg.ReconnectMin
	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		err := c.runOnce(ctx)
		if err == nil {
			// graceful exit
			return nil
		}
		c.lastErr.Set(err)

		delay := backoff
		delay += jitter(backoff / 3)
		if c.cfg.Log != nil {
			c.cfg.Log.Printf("ws disconnected: %v (reconnect in %s)", err, delay)
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}

		backoff *= 2
		if backoff > c.cfg.ReconnectMax {
			backoff = c.cfg.ReconnectMax
		}
	}
}

func (c *Client) runOnce(ctx context.Context) error {
	header := make(http.Header)
	header.Set("Authorization", "Bearer "+c.cfg.Token)
	header.Set("X-ElegantMC-Daemon", c.cfg.DaemonID)

	conn, _, err := websocket.Dial(ctx, c.cfg.URL, &websocket.DialOptions{
		HTTPHeader: header,
	})
	if err != nil {
		return err
	}
	defer func() {
		c.connMu.Lock()
		if c.conn == conn {
			c.conn = nil
		}
		c.connMu.Unlock()
		_ = conn.Close(websocket.StatusNormalClosure, "closing")
	}()

	c.connMu.Lock()
	c.conn = conn
	c.connMu.Unlock()
	if c.cfg.Log != nil {
		c.cfg.Log.Printf("ws connected: %s", c.cfg.URL)
	}

	if err := c.sendHello(ctx); err != nil {
		return err
	}

	// read loop
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var msg protocol.Message
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}

		if msg.Type == "hello_ack" {
			var ack protocol.HelloAck
			if err := json.Unmarshal(msg.Payload, &ack); err == nil {
				if err := c.checkAndBindPanel(ack.PanelID); err != nil {
					return err
				}
			}
			continue
		}

		if msg.Type == "command" {
			var cmd protocol.Command
			if err := json.Unmarshal(msg.Payload, &cmd); err != nil {
				continue
			}
			go c.handleCommand(ctx, msg.ID, cmd)
			continue
		}
	}
}

func (c *Client) sendHello(ctx context.Context) error {
	hello := protocol.Hello{
		DaemonID: c.cfg.DaemonID,
		Version:  "0.1.0",
		OS:       runtime.GOOS,
		Arch:     runtime.GOARCH,
		Features: []string{"fs", "fs_upload", "mc", "frp"},
	}
	payload, _ := json.Marshal(hello)
	return c.send(ctx, protocol.Message{
		Type:    "hello",
		TSUnix:  time.Now().Unix(),
		Payload: payload,
	})
}

func (c *Client) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(c.cfg.HeartbeatEvery)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.writeHealth()
			_ = c.sendHeartbeat(ctx)
		}
	}
}

func (c *Client) sendHeartbeat(ctx context.Context) error {
	hb := c.cfg.CommandExecutor.HeartbeatSnapshot()
	hb.DaemonID = c.cfg.DaemonID
	hb.UptimeSec = int64(time.Since(c.started).Seconds())
	hb.LastError = c.lastErr.String()
	hb.ServerTime = time.Now().Unix()
	payload, _ := json.Marshal(hb)
	return c.sendWithTimeout(ctx, protocol.Message{
		Type:    "heartbeat",
		TSUnix:  time.Now().Unix(),
		Payload: payload,
	}, 5*time.Second)
}

func (c *Client) writeHealth() {
	path := strings.TrimSpace(c.cfg.HealthFile)
	if path == "" {
		return
	}

	c.connMu.RLock()
	connected := c.conn != nil
	c.connMu.RUnlock()

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	tmp := fmt.Sprintf("%s.tmp-%d", path, time.Now().UnixNano())
	payload := fmt.Sprintf("%d %d\n", time.Now().Unix(), boolToInt(connected))
	if err := os.WriteFile(tmp, []byte(payload), 0o644); err != nil {
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(path)
		_ = os.Rename(tmp, path)
	}
	_ = os.Remove(tmp)
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func (c *Client) handleCommand(ctx context.Context, id string, cmd protocol.Command) {
	res := c.cfg.CommandExecutor.Execute(ctx, cmd)
	payload, _ := json.Marshal(res)
	_ = c.sendWithTimeout(ctx, protocol.Message{
		Type:    "command_result",
		ID:      id,
		TSUnix:  time.Now().Unix(),
		Payload: payload,
	}, 30*time.Second)
}

func (c *Client) sendWithTimeout(ctx context.Context, msg protocol.Message, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return c.send(ctx, msg)
}

func (c *Client) send(ctx context.Context, msg protocol.Message) error {
	c.connMu.RLock()
	conn := c.conn
	c.connMu.RUnlock()
	if conn == nil {
		return errors.New("not connected")
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		return err
	}
	return nil
}

type panelBindingFile struct {
	PanelID     string `json:"panel_id"`
	DaemonID    string `json:"daemon_id,omitempty"`
	BoundAtUnix int64  `json:"bound_at_unix,omitempty"`
}

func loadPanelBinding(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}

	var f panelBindingFile
	if err := json.Unmarshal(b, &f); err == nil && strings.TrimSpace(f.PanelID) != "" {
		return strings.TrimSpace(f.PanelID), nil
	}

	// Backward/repair: allow plain-text panel_id file.
	id := strings.TrimSpace(string(b))
	if id != "" && len(id) <= 128 {
		return id, nil
	}
	return "", errors.New("invalid panel binding file")
}

func writePanelBinding(path string, panelID string, daemonID string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("panel binding path is empty")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp-%d", path, time.Now().UnixNano())
	payload, _ := json.MarshalIndent(panelBindingFile{
		PanelID:     panelID,
		DaemonID:    daemonID,
		BoundAtUnix: time.Now().Unix(),
	}, "", "  ")
	payload = append(payload, '\n')
	if err := os.WriteFile(tmp, payload, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (c *Client) checkAndBindPanel(panelID string) error {
	if !c.cfg.BindPanel {
		return nil
	}
	pid := strings.TrimSpace(panelID)
	if pid == "" {
		return nil
	}
	if len(pid) > 128 {
		return errors.New("panel_id too long")
	}
	bindPath := strings.TrimSpace(c.cfg.PanelBindingPath)
	if bindPath == "" {
		return nil
	}

	c.bindMu.Lock()
	defer c.bindMu.Unlock()

	if c.boundPanelID == "" {
		if existing, err := loadPanelBinding(bindPath); err == nil {
			c.boundPanelID = strings.TrimSpace(existing)
		}
	}

	if c.boundPanelID == "" {
		if err := writePanelBinding(bindPath, pid, c.cfg.DaemonID); err != nil {
			return err
		}
		c.boundPanelID = pid
		if c.cfg.Log != nil {
			c.cfg.Log.Printf("panel bound: panel_id=%s", pid)
		}
		return nil
	}

	if c.boundPanelID != pid {
		return fmt.Errorf("panel binding mismatch: bound=%s got=%s (delete %s to rebind)", c.boundPanelID, pid, bindPath)
	}
	return nil
}

type atomicError struct {
	mu  sync.Mutex
	err error
}

func (e *atomicError) Set(err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.err = err
}

func (e *atomicError) String() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.err == nil {
		return ""
	}
	return fmt.Sprintf("%v", e.err)
}
