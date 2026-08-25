# Relay conformance

The relay HTTP contract, executable. The suite drives every relay
implementation's public endpoints with real encrypted SimplySync envelopes,
imports none of their internals, and removes all temporary state afterward.

```bash
bun test
bun run typecheck
```

- `test/conformance.test.ts` — the contract, asserted once per implementation.
  A `for (const adapter of implementations())` loop runs every assertion
  against the Go relay (a real subprocess) and the Cloudflare relay (under
  `wrangler dev --local`: local D1 + R2, no network, no account).
- `test/conformance/adapters.ts` — the seam that makes that possible: one
  descriptor per relay, naming its launcher and the numbers it enforces. A
  contract test may read an adapter's numbers; it must never read its name.
- `test/cross-relay.test.ts` — what needs both relays at once: migrating an
  owner between them, the divergences where the same request gets two answers,
  and the features only one implementation has. All pinned as they behave
  today, each naming its risk, so closing one is a deliberate edit.

Cloudflare needs wrangler, which a machine that only has Go won't have; its
blocks skip, loudly, rather than fail. That is right locally and wrong in CI,
where a green run that checked one implementation is worse than no run — so
`.github/workflows/ci.yml` sets `RELAY_REQUIRE_CLOUDFLARE=1`, which turns a
missing or broken Cloudflare harness into a failure.
