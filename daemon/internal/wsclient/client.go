package wsclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"runtime"
	"sync"
	"time"

	"elegantmc/daemon/internal/protocol"
	"nhooyr.io/websocket"
)

type CommandExecutor interface {
	BindSender(send func(msg protocol.Message))
	Execute(ctx context.Context, cmd protocol.Command) protocol.CommandResult
	HeartbeatSnapshot() protocol.Heartbeat
}

type Config struct {
	URL      string
	Token    string
	DaemonID string

	HeartbeatEvery time.Duration
	ReconnectMin   time.Duration
	ReconnectMax   time.Duration

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
	return &Client{cfg: cfg, started: time.Now()}
}

func (c *Client) Run(ctx context.Context) error {
	if c.cfg.CommandExecutor == nil {
		return errors.New("CommandExecutor is nil")
	}

	c.cfg.CommandExecutor.BindSender(func(msg protocol.Message) {
		_ = c.sendWithTimeout(ctx, msg, 5*time.Second)
	})

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
		if c.cfg.Log != nil {
			c.cfg.Log.Printf("ws disconnected: %v", err)
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
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
		if msg.Type != "command" {
			continue
		}
		var cmd protocol.Command
		if err := json.Unmarshal(msg.Payload, &cmd); err != nil {
			continue
		}
		go c.handleCommand(ctx, msg.ID, cmd)
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
