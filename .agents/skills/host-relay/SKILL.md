---
name: host-relay
description: Deploy and verify a source-owned personal SimplySync relay on Cloudflare. Use when a user says "host my own relay", "set up my own sync relay/server", asks for Cloudflare relay hosting, or wants an agent to handle Cloudflare signup, authentication, D1/R2 provisioning, migrations, deployment, and health verification end to end.
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
- Keep the app's existing local data and relay configuration intact until the
  new relay passes a real two-device sync and restore test.
- Do not imply that SimplySync provides a managed relay. This skill deploys the
  relay source from the user's checkout into the user's Cloudflare account.
- Do not call a second relay redundant until the app has pushed its existing
  encrypted history to it and the two-device restore test passes.
- Do not declare success until `<relay-url>/health` returns `ok: true`.

Before provider work, read
[references/cloudflare.md](references/cloudflare.md) completely.

## Prepare the deployment source

1. Find `apps/relay-cloudflare` in the current workspace.
2. Resolve this skill's real directory if it was opened through a symlink.
3. Create an isolated copy:

   ```bash
   node <skill-directory>/scripts/prepare-relay.mjs <apps/relay-cloudflare>
   ```

4. Use the printed `RELAY_WORKDIR=...` directory for every provider command.
5. Run `npm install` and `npm run typecheck` there before authentication.

If the deployment source is missing, ask the user to open or attach a current
SimplySync repository. Do not substitute an unrelated relay implementation.

## Hand off the verified result

Give the user:

1. The verified relay URL.
2. The app-specific connection step: paste it into the scaffold's **Relay URL**
   field, or set the relay URL environment/configuration value the app uses.
3. Make a change on one device and confirm it reaches the relay.
4. Restore the same recovery key on a second device, configure the same relay
   URL, and confirm the change appears there.
5. Keep the previous relay data/configuration until that verification succeeds.

Explain that the URL can remain public: it is an address, not a decryption or
write key. The relay stores ciphertext; recovery-phrase-derived data and write
keys stay on the user's devices.
