//go:build linux

package main

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

func diskInfo(path string) (total, free uint64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0
	}
	return uint64(st.Bsize) * st.Blocks, uint64(st.Bsize) * st.Bavail
}

// memInfo reports total and *available* memory. We read /proc/meminfo's
// MemAvailable (the kernel's estimate of memory obtainable without swapping)
// rather than Sysinfo's Freeram, which ignores reclaimable page cache and so
// massively overstates "used" on an otherwise-idle box.
func memInfo() (total, free uint64) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	var memTotal, memAvail uint64
	haveTotal, haveAvail := false, false
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		// values are in kB
		switch f[0] {
		case "MemTotal:":
			memTotal, _ = strconv.ParseUint(f[1], 10, 64)
			haveTotal = true
		case "MemAvailable:":
			memAvail, _ = strconv.ParseUint(f[1], 10, 64)
			haveAvail = true
		}
		if haveTotal && haveAvail {
			break
		}
	}
	return memTotal * 1024, memAvail * 1024
}

func loadAvg() [3]float64 {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return [3]float64{}
	}
	fields := strings.Fields(string(data))
	var out [3]float64
	for i := 0; i < 3 && i < len(fields); i++ {
		out[i], _ = strconv.ParseFloat(fields[i], 64)
	}
	return out
}
