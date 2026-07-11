# Relay conformance

Black-box HTTP contract tests for the canonical Go relay. The suite builds and
launches a temporary Go relay, drives its public endpoints with real encrypted
SimplySync envelopes, and removes all temporary state afterward.

```bash
bun test
bun run typecheck
```

The Cloudflare relay requires a separate integration harness for D1, R2, and
rate-limit bindings and is not exercised by this local suite.
