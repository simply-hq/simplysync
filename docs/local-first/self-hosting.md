# Self-Hosting a Sync Relay

A relay is a small HTTP service that stores ciphertext and nothing else. This
repository ships two interchangeable implementations of it. Both speak the same
wire contract — one conformance suite runs against both — so an app can't tell
them apart, and you can move between them or run both at once.

| | On Cloudflare | On your own server |
| --- | --- | --- |
| Stack | Workers + D1 + R2 | One Go binary + SQLite |
| Runs on | Your Cloudflare account | Any Linux server, VPS, home machine, or Docker host |
| You operate | Nothing — and you get an HTTPS `workers.dev` URL | The machine, HTTPS, and backups (configs included) |
| Setup | One command, or ask an agent | `docker compose up -d`, or a static binary |
| Pick it when | You'd rather not run a server | You'd rather not depend on any one provider |

Cloudflare comes first below because it needs the least operating;
[On your own server](#on-your-own-server) covers the Go relay.

Your relay URL does not need to be secret. SimplySync encrypts every sync event
on the device before uploading it, and the relay never receives the owner's
decryption key. Each owner is also protected by a private write capability
derived from the recovery key.

The source in this repository remains the product boundary for self-hosting:
the steps below deploy it into your Cloudflare account or onto your own
server. Optional
managed hosting is provided separately by
[SimplySync Cloud](https://cloud.simplysync.org/), whose site shows current
plans and checkout availability.

## On Cloudflare

### Easiest setup: ask an AI agent

Open this SimplySync repository in ChatGPT/Codex or Claude Code and say:

```text
Host my own SimplySync relay.
```

The repository includes the same `host-relay` skill for both agents. It checks
and installs local tooling, opens Cloudflare signup or OAuth when needed,
creates D1 and R2, applies migrations, deploys the relay, verifies `/health`,
and returns a verified URL to paste into your app's **Relay URL** setting.

The agent pauses only when Cloudflare requires you to enter a password, MFA,
CAPTCHA, billing details, or accept terms. Enter those details directly in the
Cloudflare page; never paste them into the chat.

You can also invoke it directly with `Use $host-relay to host my own SimplySync
relay.`

The agent deploys the exact checked-out source. It does not fetch a template,
publish a package, or depend on a separate relay repository. You do not need a
domain, VPS, Docker, port forwarding, private networking, or a TLS certificate.
Cloudflare provides HTTPS for the public relay address.

### One setup command from a selective clone

```bash
curl -fsSL https://raw.githubusercontent.com/simply-hq/simplysync/main/clone-simplysync.sh |
  sh -s -- relay-cloudflare simplysync-cloudflare-relay
cd simplysync-cloudflare-relay
bun install --no-save
bun run relay:cloudflare:setup
```

The selective clone contains only the Cloudflare relay and repository-level
scripts. The final command authenticates, creates or reuses D1 and R2, applies
migrations, deploys, and waits for `/health` to return `{"ok":true}` before it
prints the relay URL.

### Check that it works

1. Require the setup command to print `Relay verified` and the relay URL.
2. Paste the URL into the first device's **Relay URL** field and sync a change.
3. Restore the same recovery key on a second device, configure the same URL,
   and confirm the change appears there.
4. Keep any previous relay data or configuration until this test succeeds. Do
   not call the new relay redundant until existing encrypted history has been
   pushed to it and the restore test passes.

### What Cloudflare creates

| Resource | Purpose |
| --- | --- |
| Worker | Receives authenticated sync requests at your public relay URL. |
| D1 database | Stores encrypted events and small routing metadata. |
| R2 bucket | Stores encrypted attachment chunks. |

The default relay includes per-IP and per-owner rate limits, request-size caps,
an owner-count cap, and per-owner storage quotas. A personal deployment can use
its generated `workers.dev` address directly. Custom domains and additional WAF
rules are optional controls for larger shared deployments, not setup
requirements.

### Basic maintenance

- Keep the Cloudflare account accessible and enable usage notifications if you
  want alerts.
- Cloudflare runs log compaction automatically every six hours.
- If the relay is unavailable, the app keeps working locally and resumes
  sync when it returns.
- Removing a relay URL from the app does not delete local app data.

For implementation details and advanced controls, see the
[`relay-cloudflare` README](../../apps/relay-cloudflare/README.md).

## On your own server

The Go relay (`apps/relay-go`) is one static binary over SQLite: no runtime to
install, no `node_modules`, and little memory, so it runs on anything from a small
VPS to a spare machine at home. It serves exactly the endpoints the Cloudflare
relay does, so apps need no changes — point them at its URL.

### With Docker

```bash
curl -fsSL https://raw.githubusercontent.com/simply-hq/simplysync/main/clone-simplysync.sh |
  sh -s -- relay-go simplysync-relay
cd simplysync-relay/apps/relay-go
docker compose up -d                  # builds the image, serves port 4100
curl -s http://localhost:4100/health  # {"ok":true,...}
```

All state lives in a named Docker volume, so `docker compose down` and image
upgrades keep it.

### Without Docker

```bash
cd simplysync-relay/apps/relay-go
make build-linux   # a static binary for any distro; build-linux-arm64 for ARM
```

This needs Go installed; the exact version the relay pins is fetched on first
build. To run it as a service,
[`deploy/DEPLOY.md`](../../apps/relay-go/deploy/DEPLOY.md) walks through systemd,
TLS, and backups step by step.

### Give it an HTTPS URL

Port 4100 speaks plain HTTP, and apps need HTTPS, so put a reverse proxy that
terminates TLS in front of it. The included
[`deploy/Caddyfile`](../../apps/relay-go/deploy/Caddyfile) does this with an
automatic certificate — replace its domain with yours. Then set
`TRUST_PROXY_HEADERS=1` so rate limits see each client's real address, and keep
port 4100 reachable only from the proxy: with that flag on, anyone who reaches
the relay directly can forge their IP.

Then run the same end-to-end test as for Cloudflare: steps 2–4 of
[Check that it works](#check-that-it-works).

### Configuration

Everything is an environment variable, and the defaults are sensible. The ones
you are most likely to change:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `4100` | Listen port. |
| `RELAY_DATA_DIR` | `data` | Where the SQLite database lives. |
| `MAX_OWNER_BYTES` | 1 GiB | Storage quota per owner. |
| `MAX_TOTAL_BYTES` | off | Ceiling across all owners. Set it to the disk size minus headroom, so a few full owners can't fill the volume. |
| `ADMIN_TOKEN` | unset | Enables the ops dashboard at a secret path, printed to the logs. |
| `TRUST_PROXY_HEADERS` | off | Trust the proxy's forwarded client IP. Only behind a proxy that overwrites it. |

The full list is in the [relay-go README](../../apps/relay-go/README.md).

### Backups

Losing the relay's database isn't fatal: every device keeps the whole database
and uploads it again to an empty relay. Blob chunks are the exception — they
live only on the relay (see below) — so back the database up if your app stores
images or files. The deploy kit streams it continuously with
[Litestream](https://litestream.io) to any S3-compatible bucket; the example
config targets Cloudflare R2, but AWS S3, Backblaze B2, or MinIO work the same
way. [`deploy/DEPLOY.md`](../../apps/relay-go/deploy/DEPLOY.md) includes a
restore drill.

## Moving existing data to your relay

Your data, identity, and encryption keys derive from your recovery phrase; they
are not tied to a particular relay — or to a provider. Nothing needs exporting
from the old relay: every device keeps the whole database, and the engine
uploads a full copy of the current rows to any relay it hasn't synced with
before. You can list both relays while you move — each one receives every
change — and remove the old one once the new one checks out.

1. Configure the new relay on the device that has the complete local history.
2. Sync so that history is pushed to the new relay.
3. Restore the same recovery key on another device, configure the new URL, and
   confirm the historical and new rows both appear.
4. Retain the old relay data/configuration until this test succeeds.

**Blob chunks don't move with the rows.** Images and other blobs are stored only
on the relay that received them, and the engine keeps no local copy, so moving
relays carries their manifests across but not their bytes. Re-upload them from
wherever your app keeps the originals before you retire the old relay.

## Security model

The relay stores only:

- encrypted event ciphertext,
- a pseudonymous owner id,
- a hash of the owner's write capability, and
- encrypted attachment chunks.

A malicious or compromised relay can refuse to sync or delete stored events,
but it cannot read or forge your app data. Keep an encrypted backup for
disaster recovery. See [Sync & the relay](./sync.md) and the
[security model](../../SECURITY.md) for the protocol details.
