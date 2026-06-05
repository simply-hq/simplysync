//go:build !linux && !darwin

package main

func diskInfo(path string) (total, free uint64) { return 0, 0 }
func memInfo() (total, free uint64)              { return 0, 0 }
func loadAvg() [3]float64                        { return [3]float64{} }
