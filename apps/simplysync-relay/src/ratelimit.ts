// Fixed-window in-memory rate limiter for the Bun relay. Not distributed —
// per-process counters, the right fit for the single-VPS deploy this relay
// targets (the Cloudflare relay uses CF's edge rate-limit bindings instead).
// Keyed by an arbitrary string: an IP for the API limiter, an ownerId for the
// write limiter. A periodic sweep evicts expired keys so a flood of distinct
// keys can't grow the map without bound.
export class RateLimiter {
  private readonly counts = new Map<
    string,
    { windowStart: number; count: number }
  >();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    const timer = setInterval(() => this.sweep(), windowMs);
    (timer as { unref?: () => void }).unref?.();
  }

  // Returns true if key is within budget (consuming one unit); false => reject.
  allow(key: string): boolean {
    const now = Date.now();
    const wc = this.counts.get(key);
    if (!wc || now - wc.windowStart >= this.windowMs) {
      this.counts.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (wc.count >= this.limit) return false;
    wc.count += 1;
    return true;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, wc] of this.counts) {
      if (now - wc.windowStart >= this.windowMs) this.counts.delete(k);
    }
  }
}
