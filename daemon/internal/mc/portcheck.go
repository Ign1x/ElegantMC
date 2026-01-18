package mc

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func detectServerListenAddr(instanceDir string) (string, int, bool) {
	propsPath := filepath.Join(instanceDir, "server.properties")
	f, err := os.Open(propsPath)
	if err != nil {
		return "", 0, false
	}
	defer f.Close()

	b, err := io.ReadAll(io.LimitReader(f, 256*1024))
	if err != nil {
		return "", 0, false
	}
	text := string(b)

	portStr := strings.TrimSpace(getPropValue(text, "server-port"))
	if portStr == "" {
		return "", 0, false
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, false
	}

	host := strings.TrimSpace(getPropValue(text, "server-ip"))
	if host != "" {
		if ip := net.ParseIP(host); ip == nil {
			// Non-IP values are unusual; skip to avoid false positives.
			return "", 0, false
		}
	}
	return host, port, true
}

func getPropValue(text string, key string) string {
	k := key + "="
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimRight(raw, "\r")
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		if strings.HasPrefix(t, k) {
			return strings.TrimSpace(strings.TrimPrefix(t, k))
		}
	}
	return ""
}

func checkTCPPortAvailable(host string, port int) error {
	if port < 1 || port > 65535 {
		return errors.New("invalid port")
	}
	addr := net.JoinHostPort(strings.TrimSpace(host), strconv.Itoa(port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if errors.Is(err, syscall.EADDRINUSE) {
			return fmt.Errorf("port %d is already in use", port)
		}
		return fmt.Errorf("cannot listen on %s: %v", addr, err)
	}
	_ = ln.Close()
	return nil
}
