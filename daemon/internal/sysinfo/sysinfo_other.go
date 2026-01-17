//go:build !linux

package sysinfo

type CPUTracker struct{}

func (t *CPUTracker) UsagePercent() (float64, error) { return 0, nil }

type MemStats struct {
	TotalBytes     uint64
	AvailableBytes uint64
	UsedBytes      uint64
}

func ReadMemStats() (MemStats, error) { return MemStats{}, nil }

type DiskStats struct {
	Path       string
	TotalBytes uint64
	FreeBytes  uint64
	UsedBytes  uint64
}

func ReadDiskStats(path string) (DiskStats, error) { return DiskStats{Path: path}, nil }

