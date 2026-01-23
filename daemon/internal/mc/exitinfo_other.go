//go:build !linux

package mc

import "os"

func exitSignalFromProcessState(ps *os.ProcessState) string { return "" }
