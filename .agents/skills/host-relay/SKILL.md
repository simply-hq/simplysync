---
name: host-relay
description: Deploy and verify a personal SimplySync relay on Cloudflare for a non-technical user. Use when the user says "host my own relay", "set up my own sync relay/server", "deploy a Simply Finance relay", asks for Cloudflare relay hosting, or wants an agent to handle Cloudflare signup, authentication, D1/R2 provisioning, migrations, deployment, and health verification end to end.
---

# Host a SimplySync Relay

Deliver one verified public `https://...workers.dev` relay URL. Perform every
non-sensitive step. Pause only when Cloudflare requires credentials, MFA,
CAPTCHA, payment details, or legal acceptance.

## Interaction rules

- Assume no technical knowledge. Explain the current action in one plain
  sentence, then perform it.
- Never ask the user to paste passwords, API tokens, MFA codes, recovery
  phrases, or payment-card details into chat or a terminal.
- If browser control is available, navigate signup, checkout, storage, and
  consent pages. Hand control to the user before sensitive fields or required
  personal acceptance, then continue after completion.
- Do not introduce a domain, VPS, Docker, private network, or TLS setup. Use the
  generated `workers.dev` HTTPS URL.
- Keep the built-in relay enabled until the custom relay passes a real
  two-device sync and restore test.
- Do not describe the built-in relay as testing-only. It is the managed default
  for ongoing use and can remain enabled alongside the custom relay. Simply
  Finance may retire it later only if demand outgrows sustainable capacity.
- Do not declare success until `<relay-url>/health` returns `ok: true`.

Before provider work, read
[references/cloudflare.md](references/cloudflare.md) completely.

## Prepare the deployment source

1. Find `relays/cloudflare` in the current workspace.
2. Resolve this skill's real directory if it was opened through a symlink.
3. Create an isolated copy:

   ```bash
   node <skill-directory>/scripts/prepare-relay.mjs <relays/cloudflare>
   ```

4. Use the printed `RELAY_WORKDIR=...` directory for every provider command.
5. Run `npm install` and `npm run typecheck` there before authentication.

If the deployment source is missing, ask the user to open or attach a current
SimplySync repository. Do not substitute an unrelated relay implementation.

## Hand off the verified result

Give the user:

1. The verified relay URL.
2. **Simply Finance → Settings → Sync Relays → Add Relay**.
3. Keep **Built-in + custom** while verifying the new relay.
4. Make a change on one device and restore or sync the same recovery phrase on
   a second device.
5. After verification, keep both relays for redundancy or switch to **Custom
   only** if the user prefers.

Explain that the URL can remain public: it is an address, not a decryption or
write key. The relay stores ciphertext; recovery-phrase-derived data and write
keys stay on the user's devices.
