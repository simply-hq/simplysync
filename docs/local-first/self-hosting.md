# Self-Hosting a Sync Server

You don't have to rely on the bundled sync server. Because every byte is
**end-to-end encrypted on your device before it's uploaded**, the server only
ever holds ciphertext plus an owner id and an auth hash — it can never read your
finances. That makes it safe to run your own.

This guide covers running the [`relay-go`](../../apps/relay-go) server (a single
static binary, ~10 MB, low memory) and pointing the app at it.

> **The app needs no changes.** Add your server's URL under
> **Settings → Sync Servers → Add Sync Server**, and the app starts syncing to
> it. You can run it *alongside* the default server or *replace* it.

---

## Which path should I pick?

| Path | Syncs on cellular? | TLS setup | Effort | Best for |
| --- | --- | --- | --- | --- |
| **VPS + Caddy** | ✅ | automatic | ~30 min | Always-on, public domain |
| **Home box + Tailscale** | ✅ | not needed¹ | ~20 min | Privacy, no public exposure |
| **Home box + Cloudflare Tunnel** | ✅ | automatic | ~20 min | No open ports, free TLS |
| **LAN-only** | ❌ (home Wi-Fi only) | none | ~10 min | Trying it out |

¹ Tailscale encrypts all traffic itself, so plain `ws://` over the tailnet is
already private.

**Recommended:** a home box (or a $5/mo VPS) reached over **Tailscale**. It syncs
anywhere — including cellular — with no port-forwarding, no public exposure, and
no certificate to manage.

> ⚠️ **Pure LAN-only has a catch:** your phone only syncs while it's on the same
> Wi-Fi. The moment it's on cellular, it goes stale until it's home again. Use it
> to try things out, then upgrade to Tailscale/Caddy for sync-anywhere.

---

## Run the server (Docker — recommended)

From the repo root:

```bash
# Build and start in the background.
ADMIN_TOKEN=$(openssl rand -hex 16) docker compose -f apps/relay-go/docker-compose.yml up -d

# Confirm it's healthy.
curl http://localhost:4100/health        # -> {"ok":true}

# Find the secret ops-dashboard path (only printed when ADMIN_TOKEN is set).
docker compose -f apps/relay-go/docker-compose.yml logs | grep "Ops dashboard"
```

Data persists in the `relay-data` named volume (all SQLite WAL files live under
`/data`). `docker compose down` stops the server without deleting data.

### Without Docker

The server is a single static binary — see
[`apps/relay-go/README.md`](../../apps/relay-go/README.md) for `make build-linux`
+ systemd instructions. Everything below (TLS, Tailscale, Cloudflare) applies the
same way.

---

## Path 1 — VPS + Caddy (public domain, auto-TLS)

On a small VPS with a domain pointed at it:

1. Run the server (Docker, as above) listening on `127.0.0.1:4100`.
2. Put [Caddy](https://caddyserver.com) in front for automatic Let's Encrypt TLS:

   ```caddyfile
   # /etc/caddy/Caddyfile
   relay.example.com {
       reverse_proxy 127.0.0.1:4100
   }
   ```

3. In the app: **Add Sync Server → `wss://relay.example.com`**.

`wss://` (TLS) means it syncs from anywhere, including cellular.

---

## Path 2 — Home box + Tailscale (recommended)

Run the server on any always-on machine at home (NAS, mini-PC, Raspberry Pi):

1. Install [Tailscale](https://tailscale.com) on the box and on your phone, both
   signed into the same account: `tailscale up`.
2. Run the server (Docker, as above).
3. Find the box's tailnet address — either its `100.x.y.z` IP or its MagicDNS
   name (`tailscale status`).
4. In the app: **Add Sync Server → `ws://home-box.your-tailnet.ts.net:4100`**
   (plain `ws://` is fine — Tailscale already encrypts the link).

Now your phone syncs to home over the encrypted tailnet from anywhere, with no
ports exposed to the public internet and no certificates to manage.

---

## Path 3 — Home box + Cloudflare Tunnel (no open ports)

If you have a Cloudflare-managed domain and don't want to open any ports:

1. Run the server (Docker, as above) on `127.0.0.1:4100`.
2. Install `cloudflared` and create a tunnel mapping a hostname to the relay:

   ```bash
   cloudflared tunnel create simplysync-relay
   cloudflared tunnel route dns simplysync-relay relay.example.com
   # ingress: relay.example.com -> http://localhost:4100
   cloudflared tunnel run simplysync-relay
   ```

3. In the app: **Add Sync Server → `wss://relay.example.com`**.

Cloudflare provides TLS at the edge and the box needs no inbound ports.

---

## Path 4 — LAN-only (simplest, home Wi-Fi only)

For a quick local trial:

1. Run the server on a machine on your Wi-Fi and note its LAN IP (e.g.
   `192.168.1.50`).
2. In the app: **Add Sync Server → `ws://192.168.1.50:4100`**.

Both devices must be on the same network. **This will not sync over cellular.**
When you're ready to sync anywhere, layer Tailscale on top (Path 2) — the server
doesn't change, only the address you point the app at.

> 💡 **Auto-discovery:** set `MDNS_ENABLE=1` and use host networking
> (uncomment the lines in `docker-compose.yml`) and the app can find the server
> on your LAN automatically — no typing IP addresses. See the discovery section
> in the app's Add Sync Server screen.

---

## Peer-to-peer on your LAN (no cloud)

You don't need a cloud server at all. Because the sync protocol is just HTTP and
every relay is a dumb encrypted-event store, the supported "device-to-device"
setup is:

1. Run `relay-go` on **any always-on machine on your home network** — a laptop,
   a mini-PC, a NAS, a Raspberry Pi, even a spare phone via Termux.
2. Start it with `MDNS_ENABLE=1` (and host networking, if using Docker) so it
   advertises itself on the LAN.
3. On each device: **Add Sync Server**, and it appears automatically under
   "Found on your network" — one tap to add, no IP typing.

All your devices then sync to each other through that box, fully offline, with
the relay never seeing plaintext. Add Tailscale to the same box (Path 2) and it
keeps working when you leave the house.

> **Fully serverless, in-app peer sync (running the relay *inside* the app, with
> no separate machine at all) is on the roadmap but not yet shipped.** It needs
> an embedded HTTP server in the app and is constrained by iOS background
> suspension (it could only sync while both apps are foregrounded). The
> LAN-relay approach above is the supported peer-to-peer path today and is more
> reliable. See the "True P2P" notes in the design plan for the embedded-relay
> design if you want to pursue it.

## Moving your data to your own server

Your data, identity, and encryption keys all derive from your **recovery phrase**
— they're not tied to any particular server. To migrate:

1. Stand up your server (any path above) and add it in the app.
2. The app pushes your existing encrypted history to the new server on the next
   sync. Nothing is lost; the server just receives the same encrypted events.
3. (Optional) Once you've confirmed it's syncing, you can **Replace** the default
   server so the app talks only to yours.

To move to a *new device* entirely — or as a disaster-recovery backup that
doesn't depend on any server being alive — use **Settings → Encrypted Backup**,
which writes a single passphrase-protected file containing your data *and* keys.
Restoring it adopts your identity and re-imports everything.

---

## Threat model (unchanged when self-hosting)

The server stores only:

- the **ciphertext** of each event (AES-GCM, encrypted with a key derived from
  your recovery phrase — the server never has it),
- your **owner id** (a random 16-byte id, not derivable back to the phrase),
- a **hash** of your write token (for trust-on-first-use auth).

A malicious or compromised server can refuse to sync or drop events, but it
**cannot read or forge your data**. Running your own server simply means *you*
are the one who can't read it either — it's just encrypted storage you control.
See [Sync & the relay](./sync.md) for the full cryptographic design.
