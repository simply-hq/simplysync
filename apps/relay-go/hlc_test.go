package main

import (
	"strconv"
	"testing"
)

func TestClassifyHLCAt(t *testing.T) {
	const now int64 = 1_700_000_000_000
	canonical := "00loyw3v28-000z-device.with-tab-suffix"
	if status := classifyHLCAt(canonical, now); status != hlcAdmissible {
		t.Fatalf("canonical HLC rejected: status=%v", status)
	}

	for _, malformed := range []string{
		"garbage",
		"0000000000-000-device",
		"0000000000-00000-device",
		"000000000!-0000-device",
		"0000000000-000!-device",
		"0000000000-0000-",
		"0000000000-0000-device space",
	} {
		if got := classifyHLCAt(malformed, now); got != hlcMalformed {
			t.Errorf("classifyHLCAt(%q) = %v, want malformed", malformed, got)
		}
	}
}

func TestClassifyHLCAtRejectsFutureDrift(t *testing.T) {
	const now int64 = 1_700_000_000_000
	atBoundary := strconvBase36Padded(now+hlcMaxFutureDriftMillis, 10) + "-0000-peer"
	afterBoundary := strconvBase36Padded(now+hlcMaxFutureDriftMillis+1, 10) + "-0000-peer"
	if got := classifyHLCAt(atBoundary, now); got != hlcAdmissible {
		t.Fatalf("boundary HLC = %v, want admissible", got)
	}
	if got := classifyHLCAt(afterBoundary, now); got != hlcFuture {
		t.Fatalf("future HLC = %v, want future", got)
	}
}

func strconvBase36Padded(value int64, width int) string {
	raw := strconv.FormatInt(value, 36)
	for len(raw) < width {
		raw = "0" + raw
	}
	return raw
}
