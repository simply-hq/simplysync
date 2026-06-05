# SimplySync Cloudflare relay

A serverless deployment of the local-first sync relay on **Cloudflare Workers +
D1 + R2**. It is wire-compatible with the Bun reference relay
(`apps/simplysync-relay`): same endpoints, same request/response shapes, same
end-to-end-encrypted threat model. Point the app's relay URL at your Worker and
nothing else changes.

| Concern | Where it lives | Why |
| --- | --- | --- |
| Owner metadata + event log | **D1** | Small rows, keyset-paginated, indexed. Stays well under D1's size ceiling. |
| Encrypted blob chunks | **R2** | Large binary; cheap storage and **free egress**. D1 is the wrong store for 8 MiB chunks. |
| Per-IP / per-owner limits | **Rate-limit bindings** | In-colo, in-memory, effectively free. |

## Why this is designed against "wallet DDoS"

Workers, D1, and R2 are billed per use, and Cloudflare has **no hard spend cap**
on the Workers Paid plan. So the relay is built so a stranger who knows the URL
can't run up the bill. Defenses are layered cheapest-first — each layer sheds
load before the next, more expensive one runs:

1. **Cloudflare managed DDoS protection** (free, automatic, unmetered). L3/4/7
   volumetric attacks are dropped at the edge and Cloudflare does **not** bill
   you for traffic its managed rules mitigate. Nothing to configure.

2. **Zone WAF rate-limit rule** (you must add this — see below). Runs *before*
   the Worker, so requests it blocks are **not billed as Worker invocations**.
   This is the primary wallet guard. Requires the Worker on a **custom domain /
   zone** (not just `*.workers.dev`).

3. **In-Worker rate-limit bindings** (`API_LIMITER`, `CREATE_LIMITER`,
   `WRITE_LIMITER`). Per-IP, per-owner, and per-IP-owner-creation budgets.
   In-colo and ~free; catch what slips past the WAF and give finer per-owner
   control.

4. **Cheap-path rejection ordering** (in `src/index.ts`). `/health`, CORS
   pre-flight, bad methods, missing tokens, and oversized `Content-Length` are
   all rejected on **pure Worker CPU — zero D1 reads, zero R2 ops**. Only
   well-formed, authenticated, in-budget requests ever touch a metered store.

5. **Hard quotas + caps**, so even authenticated abuse is bounded:
   - `MAX_OWNER_BYTES` — per-owner storage ceiling (events + blobs), charged
     precisely (duplicates cost nothing).
   - `MAX_OWNERS` — global fleet cap via a single counter row (no `count(*)`
     scan on the hot path). New owners can't be minted past it.
   - `MAX_EVENT_BYTES`, `MAX_EVENTS_PER_PUSH/PULL`, `MAX_BLOB_BYTES` — per-
     request bounds.
   - `RELAY_DISABLED=true` — kill switch: writes return 503, reads still work.

6. **Blob caching.** Blobs are encrypted + content-addressed, so a cache rule on
   `/v1/blobs/*` lets repeat reads serve from cache — no R2 Class-B op, no
   Worker compute — and R2 egress is free regardless.

> The relay is **trust-on-first-use** per owner: the first request for an owner
> id binds the hash of its relay-auth token; later requests must match. That
> means one stranger can't write to *your* owner — but anyone can still create
> *new* owners. That vector is what layers 2/3/5 bound (per-IP creation limit +
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

## One-time setup

```bash
cd apps/relay-cloudflare
bun install                      # or npm/pnpm

# 1. Create the stores
bunx wrangler d1 create simplysync-relay        # paste database_id into wrangler.toml
bunx wrangler r2 bucket create simplysync-relay-blobs

# 2. Apply the schema
bun run migrate:remote                   # wrangler d1 migrations apply simplysync-relay --remote

# 3. Deploy
bun run deploy
```

Then in the **Cloudflare dashboard** (the parts a Worker can't configure itself):

- **Custom domain.** Add a route like `sync.example.com/*` to the Worker
  so zone-level WAF + cache rules apply.
- **WAF → Rate limiting rule** (the load-bearing wallet guard):
  - Match: `http.request.uri.path contains "/v1/"`
  - Counting: by `IP`
  - Threshold: e.g. **100 requests / 10s**, action **Block** for 60s.
  - Add a second, stricter rule for `POST /v1/events` if you expect mostly pulls.
- **Caching → Cache rule** on `http.request.uri.path contains "/v1/blobs/"` with
  *Eligible for cache* + *Respect origin* TTL.
- **Notifications**: enable **Workers / D1 / R2 usage** and **billing** alerts so
  any cost spike pages you. (Cloudflare has no hard spend cap; alerts are how you
  catch an attack that defeats the rate limits.)

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
