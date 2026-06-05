//go:build darwin

package main

import "syscall"

// Darwin is for local dev only; the deploy target is Linux. Disk is real
// (handy for smoke tests); mem/load return zeros (dashboard shows 0%).

func diskInfo(path string) (total, free uint64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0
	}
	return uint64(st.Bsize) * uint64(st.Blocks), uint64(st.Bsize) * uint64(st.Bavail)
}

func memInfo() (total, free uint64) { return 0, 0 }

func loadAvg() [3]float64 { return [3]float64{} }
