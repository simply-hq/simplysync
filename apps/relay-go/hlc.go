package main

import (
	"regexp"
	"strconv"
)

const hlcMaxFutureDriftMillis int64 = 5 * 60 * 1000

type hlcAdmissibility int

const (
	hlcMalformed hlcAdmissibility = iota
	hlcAdmissible
	hlcFuture
)

var canonicalHLC = regexp.MustCompile(`^([0-9a-z]{10})-([0-9a-z]{4})-([A-Za-z0-9_.-]+)$`)

func classifyHLCAt(value string, nowMillis int64) hlcAdmissibility {
	match := canonicalHLC.FindStringSubmatch(value)
	if match == nil {
		return hlcMalformed
	}
	millis, err := strconv.ParseInt(match[1], 36, 64)
	if err != nil {
		return hlcMalformed
	}
	if _, err := strconv.ParseInt(match[2], 36, 32); err != nil {
		return hlcMalformed
	}
	if millis > nowMillis+hlcMaxFutureDriftMillis {
		return hlcFuture
	}
	return hlcAdmissible
}
