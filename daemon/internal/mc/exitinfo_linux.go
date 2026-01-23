//go:build linux

package mc

import (
	"os"
	"syscall"
)

func exitSignalFromProcessState(ps *os.ProcessState) string {
	if ps == nil {
		return ""
	}
	ws, ok := ps.Sys().(syscall.WaitStatus)
	if !ok {
		return ""
	}
	if !ws.Signaled() {
		return ""
	}
	sig := ws.Signal()
	if sig == 0 {
		return ""
	}
	return sig.String()
}
