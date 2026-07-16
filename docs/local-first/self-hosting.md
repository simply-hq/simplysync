# Self-Hosting a Sync Relay

You can run a Simply Finance sync relay in your own Cloudflare account without
using a terminal or knowing how to manage a server. The relay gets a public
`workers.dev` URL that works from anywhere.

Your relay URL does not need to be secret. Simply Finance encrypts every sync
event on your device before uploading it, and the relay never receives the key
that can decrypt your finances. Each owner is also protected by a private write
capability derived from the recovery phrase.

The built-in relay is the managed default and is intended for ongoing use, not
just testing. Simply Finance plans to keep it available for as long as capacity
allows, but it may be retired later if demand grows beyond what can be
sustainably provided. Hosting your own relay gives you an independent sync
path.

## Easiest setup: ask an AI agent

Open this SimplySync repository in ChatGPT/Codex or Claude Code and say:

```text
Host my own SimplySync relay.
```

The repository includes the same `host-relay` skill for both agents. It checks
and installs local tooling, opens Cloudflare signup or OAuth when needed,
creates D1 and R2, applies migrations, deploys the relay, verifies `/health`,
and returns the URL to paste into Simply Finance.

The agent pauses only when Cloudflare requires you to enter a password, MFA,
CAPTCHA, billing details, or accept terms. Enter those details directly in the
Cloudflare page; never paste them into the chat.

You can also invoke it directly with `Use $host-relay to host my own SimplySync
relay.`

## Alternative: deploy in your browser

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/simply-hq/simplysync/tree/main/relays/cloudflare)

1. Select **Deploy to Cloudflare** above.
2. Sign in to Cloudflare. Connect GitHub or GitLab if Cloudflare asks where to
   create your copy of the relay.
3. Keep the suggested names and select **Deploy**.
4. Wait for Cloudflare to finish. It creates the relay, encrypted-event
   database, and encrypted-blob storage automatically.
5. Copy the address ending in `.workers.dev`.
6. In Simply Finance, open **Settings → Sync Relays**, add that address, and
   leave the mode on **Built-in + custom** while verifying the new relay.

That is the complete setup. You do not need a domain, VPS, Docker, port
forwarding, private networking, or a TLS certificate. Cloudflare provides HTTPS
for the public relay address.

## Check that it works

1. Open the relay address in a browser with `/health` added to the end.
2. Confirm the page shows `"ok": true`.
3. Add or edit something in Simply Finance and wait for the relay status to
   become healthy.
4. Restore the same recovery phrase on a second device and confirm the change
   appears there.
5. After verification, keep **Built-in + custom** for redundancy or choose
   **Custom only** if you prefer to stop using the built-in relay.

## What Cloudflare creates

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

## Basic maintenance

- Keep the Cloudflare account accessible and enable usage notifications if you
  want alerts.
- Cloudflare runs log compaction automatically every six hours.
- If the relay is unavailable, Simply Finance keeps working locally and resumes
  sync when it returns.
- Removing a custom relay from the app does not delete your local finance data.

For implementation details and advanced controls, see the
[`relay-cloudflare` README](../../relays/cloudflare/README.md).

## Advanced: host the Go relay on your own machine

This route is for people who already manage a VPS, NAS, or server. It is not
required for ordinary self-hosting.

```bash
git clone https://github.com/simply-hq/simplysync.git
cd simplysync
./scripts/self-host-relay.sh
```

The starter builds the Go relay, runs it with persistent Docker storage, and
checks `http://localhost:4100/health`. Before adding it to a phone, expose it at
a normal public `https://` address with a reverse proxy such as Caddy:

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:4100
}
```

Then add `https://relay.example.com` under **Settings → Sync Relays**. See the
[`relay-go` deployment guide](../../relays/go/deploy/DEPLOY.md) for backups,
systemd, and production operations.

## Moving existing data to your relay

Your data, identity, and encryption keys derive from your recovery phrase; they
are not tied to a particular relay.

1. Add the new relay while using **Built-in + custom** mode.
2. The next sync backfills your encrypted history to it.
3. Confirm sync and restore on another device.
4. Optionally switch to **Custom only**.

## Security model

The relay stores only:

- encrypted event ciphertext,
- a pseudonymous owner id,
- a hash of the owner's write capability, and
- encrypted attachment chunks.

A malicious or compromised relay can refuse to sync or delete stored events,
but it cannot read or forge your financial data. Keep an encrypted backup for
disaster recovery. See [Sync & the relay](./sync.md) and the
[security model](../../SECURITY.md) for the protocol details.
