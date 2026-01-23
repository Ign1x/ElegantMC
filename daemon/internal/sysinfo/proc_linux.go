//go:build linux

package sysinfo

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func ReadCPUTicks() (total uint64, idle uint64, err error) {
	return readProcStatCPU()
}

func ReadProcCPUTicks(pid int) (uint64, error) {
	if pid <= 0 {
		return 0, errors.New("invalid pid")
	}

	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, err
	}
	s := string(b)
	// comm is inside parentheses and can contain spaces; parse from the last ')'.
	end := strings.LastIndexByte(s, ')')
	if end < 0 {
		return 0, errors.New("unexpected /proc/<pid>/stat format")
	}
	rest := strings.Fields(s[end+1:])
	// rest[0] is state (field 3), utime is field 14, stime is field 15.
	if len(rest) < 13 {
		return 0, errors.New("unexpected /proc/<pid>/stat fields")
	}
	utime, err := strconv.ParseUint(rest[11], 10, 64)
	if err != nil {
		return 0, err
	}
	stime, err := strconv.ParseUint(rest[12], 10, 64)
	if err != nil {
		return 0, err
	}
	return utime + stime, nil
}

func ReadProcRSSBytes(pid int) (uint64, error) {
	if pid <= 0 {
		return 0, errors.New("invalid pid")
	}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/statm", pid))
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(b))
	if len(fields) < 2 {
		return 0, errors.New("unexpected /proc/<pid>/statm format")
	}
	rssPages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, err
	}
	return rssPages * uint64(os.Getpagesize()), nil
}
