package main

import (
	"context"
	"sync"
	"time"
)

// ownerWaiters lets a pull with `wait=N` block until a push for its owner
// lands (or the wait expires), so a device sees another device's change
// within one round trip instead of on its next poll. One in-process registry:
// the relay is a single process, so a notify reaches every open pull.
type ownerWaiters struct {
	mu      sync.Mutex
	waiters map[string]map[chan struct{}]struct{}
}

func newOwnerWaiters() *ownerWaiters {
	return &ownerWaiters{waiters: map[string]map[chan struct{}]struct{}{}}
}

// subscribe registers interest BEFORE the caller lists events, so a push that
// lands between the list and the wait is not missed. Always call cancel.
func (w *ownerWaiters) subscribe(owner string) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	w.mu.Lock()
	set := w.waiters[owner]
	if set == nil {
		set = map[chan struct{}]struct{}{}
		w.waiters[owner] = set
	}
	set[ch] = struct{}{}
	w.mu.Unlock()
	return ch, func() {
		w.mu.Lock()
		if set := w.waiters[owner]; set != nil {
			delete(set, ch)
			if len(set) == 0 {
				delete(w.waiters, owner)
			}
		}
		w.mu.Unlock()
	}
}

// notify wakes every pull waiting on owner. Non-blocking: a waiter that was
// already signalled keeps its one buffered wake-up.
func (w *ownerWaiters) notify(owner string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for ch := range w.waiters[owner] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// awaitWake returns on a notification, the deadline, or the request going away.
func awaitWake(ctx context.Context, ch <-chan struct{}, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ch:
	case <-timer.C:
	case <-ctx.Done():
	}
}
