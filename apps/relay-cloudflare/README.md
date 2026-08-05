# Cloudflare relay (`@sbt/relay-cloudflare`)

A serverless deployment of the local-first sync relay on **Cloudflare Workers +
D1 + R2**. It is wire-compatible with the canonical Go relay
(`apps/relay-go`): same endpoints, same request/response shapes, same
end-to-end-encrypted threat model. Point the app's relay URL at your Worker and
nothing else changes.

## Ask an AI agent (recommended)

With this repository open in ChatGPT/Codex or Claude Code, say:

```text
Host my own SimplySync relay.
```

The repo-owned skill performs setup, Cloudflare authentication, provisioning,
migrations, deployment, and health verification. It hands the browser to you
only for credentials, MFA, CAPTCHA, payment details, or required acceptance.
Use `Use $host-relay to host my own SimplySync relay.` if you want to invoke the
skill explicitly.

The `workers.dev` URL can stay public. Knowing it does not reveal app data or
let someone write to an existing owner: payloads are encrypted on-device and
each owner is protected by a recovery-key-derived write capability. The relay
also limits new owners, requests, writes, and stored bytes.

| Concern | Where it lives | Why |
| --- | --- | --- |
| Owner metadata + event log | **D1** | Small rows, keyset-paginated, indexed. Stays well under D1's size ceiling. |
| Encrypted blob chunks | **R2** | Large binary; cheap storage and **free egress**. D1 is the wrong store for 8 MiB chunks. |
| Per-IP / per-owner limits | **Rate-limit bindings** | In-colo, in-memory, effectively free. |

## Why this is designed against "wallet DDoS"

Workers, D1, and R2 can be billed per use, so the relay bounds what a stranger
who knows its public URL can consume. Defenses are layered cheapest-first —
each layer sheds load before the next, more expensive one runs:

1. **Cloudflare managed DDoS protection** (free, automatic, unmetered). L3/4/7
   volumetric attacks are dropped at the edge and Cloudflare does **not** bill
   you for traffic its managed rules mitigate. Nothing to configure.

2. **In-Worker rate-limit bindings** (`API_LIMITER`, `CREATE_LIMITER`,
   `WRITE_LIMITER`). Per-IP, per-owner, and per-IP-owner-creation budgets.
   These protect the default `workers.dev` deployment without extra setup.

3. **Cheap-path rejection ordering** (in `src/index.ts`). `/health`, CORS
   pre-flight, bad methods, missing tokens, and oversized `Content-Length` are
   all rejected on **pure Worker CPU — zero D1 reads, zero R2 ops**. Only
   well-formed, authenticated, in-budget requests ever touch a metered store.

4. **Hard quotas + caps**, so even authenticated abuse is bounded:
   - `MAX_OWNER_BYTES` — per-owner storage ceiling (events + blobs), charged
     precisely (duplicates cost nothing).
   - `MAX_OWNERS` — global fleet cap via a single counter row (no `count(*)`
     scan on the hot path). New owners can't be minted past it.
   - `MAX_EVENT_BYTES`, `MAX_EVENTS_PER_PUSH/PULL`, `MAX_BLOB_BYTES`,
     `MAX_STREAMS_PER_COMPACT` — per-request bounds.
   - `RELAY_DISABLED=true` — kill switch: writes return 503, reads still work.

5. **Optional custom-domain controls.** Larger or shared deployments can add a
   zone-level WAF rule and blob cache in front of the Worker. A personal relay
   does not need a custom domain to function safely.

6. **Blob caching.** On a custom domain, blobs are encrypted + content-addressed, so a cache rule on
   `/v1/blobs/*` lets repeat reads serve from cache — no R2 Class-B op, no
   Worker compute — and R2 egress is free regardless.

> The relay is **trust-on-first-use** per owner: the first request for an owner
> id binds the hash of its relay-auth token; later requests must match. That
> means one stranger can't write to *your* owner — but anyone can still create
> *new* owners. That vector is what layers 2/4 bound (per-IP creation limit +
> global owner cap). If you ever want creation to cost the client real work,
> add a hashcash proof-of-work header on the create path; the layout leaves room
> for it without breaking existing clients.

## Log compaction (Cron Trigger)

The event log is append-only, so edited rows accumulate superseded events. A
**Cron Trigger** (`[triggers]` in `wrangler.toml`, every 6h) runs the
`scheduled()` handler, which keeps only the last-writer value per logical row
and deletes the rest — so D1 stays small and per-owner quotas reflect current
footprint. Running it from the Cron-triggered Worker (next to D1 via its
binding) is the correct way to maintain D1, not an external box reaching in over
the HTTP API. Adjust the schedule in `wrangler.toml`.

## Terminal setup

```bash
# From an empty directory, clone only the Cloudflare relay source.
curl -fsSL https://raw.githubusercontent.com/simply-hq/simplysync/main/clone-simplysync.sh |
  sh -s -- relay-cloudflare simplysync-cloudflare-relay
cd simplysync-cloudflare-relay
bun install --no-save
bun run relay:cloudflare:setup
```

The guided command opens Cloudflare sign-in when needed, creates or reuses the
`sbt-relay` D1 database and `sbt-relay-blobs` R2 bucket, writes the D1 id into
the local Wrangler config, applies migrations, deploys the Worker, and verifies
the relay's `/health` endpoint. It prints the verified relay URL and is safe to
rerun after pulling relay updates. Paste that URL into the **Relay URL** setting
shipped by the runnable SimplySync scaffolds.

To verify an already deployed URL again:

```bash
bun run --cwd apps/relay-cloudflare verify -- https://your-relay.workers.dev
```

To run the steps separately, use the scripts in this package:

```bash
bun run --cwd apps/relay-cloudflare migrate:remote
bun run --cwd apps/relay-cloudflare deploy
```

For a larger shared deployment, you can optionally add:

- **Custom domain.** Add a route like `sync.example.com/*` to the Worker
  so zone-level WAF + cache rules apply.
- **WAF → Rate limiting rule**:
  - Match: `http.request.uri.path contains "/v1/"`
  - Counting: by `IP`
  - Threshold: e.g. **100 requests / 10s**, action **Block** for 60s.
  - Add a second, stricter rule for `POST /v1/events` if you expect mostly pulls.
- **Caching → Cache rule** on `http.request.uri.path contains "/v1/blobs/"` with
  *Eligible for cache* + *Respect origin* TTL.
- **Notifications**: enable **Workers / D1 / R2 usage** and **billing** alerts.

## Local development

```bash
bun run migrate:local
bun run dev          # wrangler dev — local D1 + R2 emulation
```

`bun run typecheck` runs `tsc --noEmit` against `@cloudflare/workers-types`.

## Endpoints (unchanged from the reference relay)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness (no DB). |
| `POST` | `/v1/events` | Push encrypted events. |
| `GET` | `/v1/events?ownerId&after&limit` | Pull events (keyset cursor). |
| `GET` | `/v1/usage?ownerId` | Owner's stored byte count. |
| `PUT` | `/v1/blobs/:hash?ownerId` | Store an encrypted, content-addressed chunk. |
| `GET` | `/v1/blobs/:hash?ownerId` | Fetch a chunk. |
| `HEAD` | `/v1/blobs/:hash?ownerId` | Existence check (dedupe). |

All authenticated routes take `Authorization: Bearer <relayAuth>`.
