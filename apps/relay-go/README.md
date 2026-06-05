# SimplySync Go relay

A single-binary, low-memory deployment of the local-first sync relay. **Wire-
compatible** with the Bun reference relay (`apps/simplysync-relay`) and the
Cloudflare relay (`apps/relay-cloudflare`): identical endpoints, request/response
shapes, and the same end-to-end-encrypted threat model (the relay only ever
holds ciphertext + an owner id + an auth hash). Point an app's relay URL at it
and nothing else changes.

Chosen for the VPS deploy because it compiles to a **fully static binary** (no
runtime to install, no `node_modules`, no libc dependency) with stable, low
memory — ideal for a small always-on box.

## What it does (parity checklist)

- `GET /health`, `POST /v1/events` (push), `GET /v1/events` (pull, keyset
  cursor), `GET /v1/usage`, `PUT|GET|HEAD /v1/blobs/:hash`.
- Trust-on-first-use owner auth (`sha256(relayAuth)` bound on first request).
- Per-owner quota, per-event/-blob size caps, content-hash–verified blobs.
- **Log compaction**: keeps only the highest-`eventId` event per
  `(owner, streamId)` and reclaims usage (periodic + on-demand `POST <admin>/compact`).
- **Ops dashboard** at a secret, token-derived path with brute-force lockout
  (disk/runway/memory/load, growth trends, top owners) — same UI as the Bun relay.

## Build

```bash
make build              # native binary -> bin/relay
make build-linux        # static linux/amd64 -> bin/relay-linux-amd64
make build-linux-arm64  # static linux/arm64 (Ampere/Graviton)
make run                # run locally on :4100
```

`build-linux*` set `CGO_ENABLED=0`, so the output is a fully static ELF that
runs on any Linux distro (glibc *or* musl/Alpine).

## Configuration (env)

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `4100` | listen port |
| `RELAY_DATA_DIR` | `data` | SQLite location (prod: `/var/lib/simplysync-relay`) |
| `MAX_OWNER_BYTES` | `1073741824` | per-owner quota (1 GiB) |
| `MAX_EVENT_BYTES` | `262144` | per-event cap (256 KiB) |
| `MAX_BLOB_BYTES` | `8388608` | per-chunk cap (8 MiB) |
| `MAX_EVENTS_PER_PUSH` / `_PULL` | `1000` / `5000` | batch bounds |
| `COMPACTION_INTERVAL_MS` | `21600000` | log compaction cadence; `0` disables |
| `ADMIN_TOKEN` | — | enables the dashboard; unset => admin paths 404 |
| `ADMIN_PATH` | derived | override the secret dashboard path |

## Deploy (single VPS, no Docker)

```bash
make build-linux                                  # or build-linux-arm64
scp bin/relay-linux-amd64 YOUR_BOX:/tmp/relay
ssh YOUR_BOX 'sudo install -o simplysync -g simplysync /tmp/relay /opt/simplysync-relay/relay'
sudo cp deploy/simplysync-relay.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now simplysync-relay
curl -s https://sync.example.com/health
```

Backups (Litestream → R2), TLS (Caddy), the Cloudflare edge config, and the
backup/restore drill are **language-agnostic** — follow
[`../simplysync-relay/deploy/DEPLOY.md`](../simplysync-relay/deploy/DEPLOY.md)
and just substitute this `simplysync-relay.service` (it runs the binary instead of Bun).
Litestream replicates the same `relay.db` WAL regardless of which relay wrote it.

## Storage

SQLite via the pure-Go `modernc.org/sqlite` driver (no cgo). WAL mode,
`busy_timeout`, reads concurrent on a small pool; writes serialized so quota
accounting stays atomic. Same schema as the Bun relay (`owners` / `events` with
`stream_id` / `blobs`), so a Litestream-restored DB from either relay is
interchangeable.
