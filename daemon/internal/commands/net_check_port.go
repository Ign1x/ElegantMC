package commands

import (
	"fmt"
	"net"
	"strings"

	"elegantmc/daemon/internal/protocol"
)

func (e *Executor) netCheckPort(cmd protocol.Command) protocol.CommandResult {
	host, _ := asString(cmd.Args["host"])
	port, err := asInt(cmd.Args["port"])
	if err != nil {
		return fail("port must be int")
	}
	if port < 1 || port > 65535 {
		return fail("port invalid (1-65535)")
	}
	host = strings.TrimSpace(host)
	if host == "" {
		host = "0.0.0.0"
	}
	addr := fmt.Sprintf("%s:%d", host, port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return ok(map[string]any{
			"host":      host,
			"port":      port,
			"available": false,
			"error":     err.Error(),
		})
	}
	_ = ln.Close()
	return ok(map[string]any{
		"host":      host,
		"port":      port,
		"available": true,
	})
}
