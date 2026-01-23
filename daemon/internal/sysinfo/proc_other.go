//go:build !linux

package sysinfo

import "errors"

func ReadCPUTicks() (total uint64, idle uint64, err error) {
	return 0, 0, errors.New("unsupported")
}

func ReadProcCPUTicks(pid int) (uint64, error) {
	return 0, errors.New("unsupported")
}

func ReadProcRSSBytes(pid int) (uint64, error) {
	return 0, errors.New("unsupported")
}
