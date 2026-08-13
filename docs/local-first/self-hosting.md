# Self-Hosting a Sync Relay

You can run a SimplySync relay in your own Cloudflare account without learning
how to manage a server. The relay gets a public `workers.dev` URL that works
from anywhere.

Your relay URL does not need to be secret. SimplySync encrypts every sync event
on the device before uploading it, and the relay never receives the owner's
decryption key. Each owner is also protected by a private write capability
derived from the recovery key.

The source in this repository remains the product boundary for self-hosting:
the agent or command below deploys it into your Cloudflare account. Optional
managed hosting is provided separately by
[SimplySync Cloud](https://cloud.simplysync.org/), whose site shows current
plans and checkout availability.

## Easiest setup: ask an AI agent

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

## One setup command from a selective clone

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

## Check that it works

1. Require the setup command to print `Relay verified` and the relay URL.
2. Paste the URL into the first device's **Relay URL** field and sync a change.
3. Restore the same recovery key on a second device, configure the same URL,
   and confirm the change appears there.
4. Keep any previous relay data or configuration until this test succeeds. Do
   not call the new relay redundant until existing encrypted history has been
   pushed to it and the restore test passes.

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
- If the relay is unavailable, the app keeps working locally and resumes
  sync when it returns.
- Removing a relay URL from the app does not delete local app data.

For implementation details and advanced controls, see the
[`relay-cloudflare` README](../../apps/relay-cloudflare/README.md).

## Moving existing data to your relay

Your data, identity, and encryption keys derive from your recovery phrase; they
are not tied to a particular relay.

1. Configure the new relay on the device that has the complete local history.
2. Sync so that history is pushed to the new relay.
3. Restore the same recovery key on another device, configure the new URL, and
   confirm the historical and new rows both appear.
4. Retain the old relay data/configuration until this test succeeds.

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
