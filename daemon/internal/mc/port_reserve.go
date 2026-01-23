package mc

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
)

var portResMu sync.Mutex
var portResOwners = make(map[string]string) // addr -> instance_id

func normalizeBindHost(host string) string {
	h := strings.TrimSpace(host)
	if h == "" {
		return "0.0.0.0"
	}
	return h
}

func reservePort(instanceID string, host string, port int) (string, error) {
	if strings.TrimSpace(instanceID) == "" {
		return "", errors.New("instance_id is required")
	}
	if port < 1 || port > 65535 {
		return "", errors.New("invalid port")
	}
	h := normalizeBindHost(host)
	key := net.JoinHostPort(h, strconv.Itoa(port))

	portResMu.Lock()
	defer portResMu.Unlock()
	if cur, ok := portResOwners[key]; ok && cur != "" && cur != instanceID {
		return "", fmt.Errorf("port reserved: %s (by %s)", key, cur)
	}
	portResOwners[key] = instanceID
	return key, nil
}

func releasePort(instanceID string, key string) {
	if strings.TrimSpace(instanceID) == "" || strings.TrimSpace(key) == "" {
		return
	}
	portResMu.Lock()
	defer portResMu.Unlock()
	if cur, ok := portResOwners[key]; ok && cur == instanceID {
		delete(portResOwners, key)
	}
}
