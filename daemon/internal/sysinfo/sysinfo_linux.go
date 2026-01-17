//go:build linux

package sysinfo

import (
	"bufio"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

type CPUTracker struct {
	mu        sync.Mutex
	prevTotal uint64
	prevIdle  uint64
	inited    bool
}

func (t *CPUTracker) UsagePercent() (float64, error) {
	total, idle, err := readProcStatCPU()
	if err != nil {
		return 0, err
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	if !t.inited {
		t.prevTotal = total
		t.prevIdle = idle
		t.inited = true
		return 0, nil
	}

	dTotal := total - t.prevTotal
	dIdle := idle - t.prevIdle
	t.prevTotal = total
	t.prevIdle = idle

	if dTotal == 0 {
		return 0, nil
	}
	if dIdle > dTotal {
		dIdle = dTotal
	}
	used := dTotal - dIdle
	return float64(used) * 100 / float64(dTotal), nil
}

func readProcStatCPU() (total uint64, idle uint64, err error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	s := bufio.NewScanner(f)
	if !s.Scan() {
		if s.Err() != nil {
			return 0, 0, s.Err()
		}
		return 0, 0, errors.New("empty /proc/stat")
	}
	line := s.Text()
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0, errors.New("unexpected /proc/stat format")
	}

	var vals []uint64
	for _, f := range fields[1:] {
		v, err := strconv.ParseUint(f, 10, 64)
		if err != nil {
			return 0, 0, err
		}
		vals = append(vals, v)
		total += v
	}

	// idle=idle+iowait if present
	idle = vals[3]
	if len(vals) > 4 {
		idle += vals[4]
	}
	return total, idle, nil
}

type MemStats struct {
	TotalBytes     uint64
	AvailableBytes uint64
	UsedBytes      uint64
}

func ReadMemStats() (MemStats, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return MemStats{}, err
	}
	defer f.Close()

	var totalKB uint64
	var availKB uint64

	s := bufio.NewScanner(f)
	for s.Scan() {
		line := s.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			totalKB = parseMeminfoKB(line)
		} else if strings.HasPrefix(line, "MemAvailable:") {
			availKB = parseMeminfoKB(line)
		}
		if totalKB > 0 && availKB > 0 {
			break
		}
	}
	if err := s.Err(); err != nil {
		return MemStats{}, err
	}
	if totalKB == 0 {
		return MemStats{}, errors.New("MemTotal not found in /proc/meminfo")
	}
	if availKB == 0 {
		return MemStats{}, errors.New("MemAvailable not found in /proc/meminfo")
	}

	total := totalKB * 1024
	avail := availKB * 1024
	used := uint64(0)
	if total > avail {
		used = total - avail
	}

	return MemStats{
		TotalBytes:     total,
		AvailableBytes: avail,
		UsedBytes:      used,
	}, nil
}

func parseMeminfoKB(line string) uint64 {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0
	}
	v, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return v
}

type DiskStats struct {
	Path       string
	TotalBytes uint64
	FreeBytes  uint64
	UsedBytes  uint64
}

func ReadDiskStats(path string) (DiskStats, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return DiskStats{}, err
	}
	bsize := uint64(st.Bsize)
	total := st.Blocks * bsize
	free := st.Bavail * bsize
	used := uint64(0)
	if total > free {
		used = total - free
	}
	return DiskStats{
		Path:       path,
		TotalBytes: total,
		FreeBytes:  free,
		UsedBytes:  used,
	}, nil
}

