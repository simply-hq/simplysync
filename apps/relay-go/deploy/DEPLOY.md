# Deploying the relay to a single VPS

A flat-cost, no-Docker production setup for `apps/relay-go`:

- The **Go relay** runs as a single static binary under **systemd** (auto-restart).
- **Litestream** streams the SQLite WAL to **Cloudflare R2** (durable backup,
  point-in-time restore, free egress).
- **Caddy** terminates TLS (auto Let's Encrypt) and reverse-proxies localhost.
- **Cloudflare** proxies DNS in front for free DDoS protection + an edge
  rate-limit rule.

Net cost: ~$5–7/mo for the VPS (e.g. Hetzner CX22) + pennies of R2 storage.
Because the bill is **fixed**, there's no wallet-DDoS surface — the worst case
under attack is degraded sync, and the app keeps working offline regardless.

---

## 0. Provision

A small Linux VPS is plenty (2 vCPU / 2–4 GB RAM). Recommended: **Hetzner CX22**.
DNS: point `sync.simplyfinance.app` at the box and enable Cloudflare proxying
(orange cloud). Open ports 80 + 443 only.

```bash
sudo adduser --system --group --home /opt/sbt-relay sbtrelay
sudo mkdir -p /var/lib/sbt-relay /etc/sbt-relay /var/log/caddy
sudo chown -R sbtrelay:sbtrelay /var/lib/sbt-relay
```

## 1. Install Litestream and Caddy

```bash
# Litestream (https://litestream.io/install)
LS=0.3.13
curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LS}/litestream-v${LS}-linux-amd64.tar.gz" \
  | sudo tar -xz -C /usr/bin litestream

# Caddy (https://caddyserver.com/docs/install)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
# ...follow Caddy's apt repo steps, then: sudo apt install caddy
```

## 2. Build the relay artifact (locally) and copy it up

Build the static relay binary for the target server architecture.

```bash
# from apps/relay-go
make build-linux
scp bin/relay-linux-amd64 YOUR_BOX:/tmp/relay
ssh YOUR_BOX 'sudo install -o sbtrelay -g sbtrelay /tmp/relay /opt/sbt-relay/relay'
```

## 3. Configure backups (R2)

Create an R2 bucket `sbt-relay-backups` and an R2 API token (S3 credentials).

```bash
sudo cp deploy/litestream.yml          /etc/sbt-relay/litestream.yml
sudo cp deploy/litestream.env.example  /etc/sbt-relay/litestream.env
sudo nano /etc/sbt-relay/litestream.env   # fill endpoint + keys
sudo chmod 600 /etc/sbt-relay/litestream.env
```

## 4. Install the services

```bash
sudo cp deploy/litestream.service          /etc/systemd/system/
sudo cp deploy/litestream-restore.service  /etc/systemd/system/
sudo cp deploy/sbt-relay.service           /etc/systemd/system/
sudo cp deploy/Caddyfile                   /etc/caddy/Caddyfile

sudo systemctl daemon-reload
sudo systemctl enable --now litestream            # continuous replication
sudo systemctl enable litestream-restore          # restore-on-boot (no-op if DB present)
sudo systemctl enable --now sbt-relay             # the relay
sudo systemctl reload caddy                        # TLS + proxy

curl -s https://sync.simplyfinance.app/health      # -> {"ok":true,...}
journalctl -u sbt-relay -f
```

## 5. Cloudflare edge config (free tier)

In the dashboard for the proxied record:

- **SSL/TLS → Full (strict)** (Caddy presents a real Let's Encrypt cert).
- **Security → WAF → Rate limiting rule**: match `uri.path contains "/v1/"`,
  count by IP, ~100 req/10s, action Block 60s. This sheds floods at the edge.
- **Caching → Cache rule** on `uri.path contains "/v1/blobs/"` (immutable,
  content-addressed → safe to cache; saves origin bandwidth).
- **Notifications**: enable origin health + traffic-spike alerts.

> Prefer not to expose a public port at all? Run a **Cloudflare Tunnel**
> (`cloudflared`) to `127.0.0.1:4100` instead of Caddy — then the box needs no
> inbound ports and the origin IP stays hidden. Skip step 1's Caddy install.

## 6. Verify backups (do this before you trust it)

```bash
litestream snapshots -config /etc/sbt-relay/litestream.yml /var/lib/sbt-relay/relay.db
# Disaster-recovery drill on a scratch path:
sudo systemctl stop sbt-relay
litestream restore -o /tmp/restore-test.db \
  -config /etc/sbt-relay/litestream.yml /var/lib/sbt-relay/relay.db
sqlite3 /tmp/restore-test.db 'select count(*) from owners;'
sudo systemctl start sbt-relay
```

## Operational dashboard

The relay ships a built-in ops dashboard for capacity planning — disk usage and
projected runway, DB growth, memory/load, request rate, per-endpoint counts, and
top owners by storage, with 24h trend sparklines.

It is hardened against discovery and brute force:

- **Off unless `ADMIN_TOKEN` is set.** When unset, every admin path 404s — there
  is no signal a dashboard exists.
- **Secret path, not `/admin`.** When enabled, the dashboard is served at a path
  derived from the token (e.g. `/ops-<hash>`), unguessable without the secret.
  `/admin` stays a plain 404. Override with `ADMIN_PATH=/your-secret-path`.
- **Brute-force lockout.** 10 failed token attempts from an IP trip a 5-minute
  cooldown (429), so the token can't be hammered even if the path leaks.
- **Constant-time token compare** on the JSON endpoint.

```bash
# enable it: uncomment ADMIN_TOKEN in sbt-relay.service, set a long random value
sudo systemctl edit --full sbt-relay        # or edit the unit file directly
sudo systemctl restart sbt-relay

# find the secret path (logged at startup, server-side only):
journalctl -u sbt-relay | grep 'Ops dashboard'
#   -> Ops dashboard: http://localhost:4100/ops-193838b1aed3b21c
```

Open `https://sync.simplyfinance.app/ops-<hash>`, paste the token (kept in the
browser's sessionStorage); it polls `<path>/stats` every 5s.

- The dashboard prompts you to act when it warns: **disk >85%**, **projected
  disk-full <30 days**, **memory >90%**, or **load > CPU count** — the early
  signals that you're approaching the box's limits and should resize or
  compact/shard the event log.
- `<path>/stats` is plain JSON (bearer-gated), so you can also scrape it into
  your own monitoring/alerting for long-term history.
- Optional extra hardening: IP-allowlist the path at the edge (see the commented
  block in `Caddyfile`) — secret path + token + lockout + IP = defense in depth.

## Log compaction

The event log is append-only, so an edited row accumulates superseded events.
The relay compacts them on a timer — for each logical row it keeps only the
last-writer value and drops the rest — so the DB stops growing with dead history
and each owner's quota reflects *current* footprint, not lifetime writes.

- Controlled by `COMPACTION_INTERVAL_MS` (default 6h; `0` disables).
- Run it on demand from the dashboard host: `POST <secret-path>/compact` with the
  admin bearer token — returns `{deletedEvents, reclaimedBytes, durationMs}`.
- The last run shows up in `<secret-path>/stats` under `maintenance`.
- Only events tagged with a `stream_id` (written by current clients) are
  compacted; older untagged events are left untouched.

## Upgrades

Rebuild the relay binary (step 2), `scp` it over, then
`sudo systemctl restart sbt-relay`. Litestream keeps replicating across the
restart; no migration needed (the relay creates tables idempotently on boot).
