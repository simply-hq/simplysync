# Cloudflare deployment

## Authenticate

1. Require Node.js 18 or newer and Wrangler 4.x.
2. Run `npx wrangler whoami` in `RELAY_WORKDIR`.
3. If unauthenticated, run `npx wrangler login --use-keyring` and keep it
   running. Open the printed OAuth URL if no browser opens.
4. If the user lacks an account, open `https://dash.cloudflare.com/sign-up`.
5. Hand control to the user for credentials, MFA, CAPTCHA, and terms.
6. Rerun `npx wrangler whoami` and confirm the intended account.

## Provision and deploy

Run:

```bash
npm run setup
```

The idempotent setup creates or reuses D1 and R2, applies migrations, deploys
the Worker, discovers its `workers.dev` URL, and verifies `/health` before it
prints the handoff.

Handle provider checkpoints:

- If R2 requires subscription checkout, open
  `https://dash.cloudflare.com/?to=/:account/r2`, navigate to checkout, and
  hand control to the user for billing details and confirmation. Retry setup.
- Accept a reasonable available `workers.dev` name.
- If multiple accounts are plausible, show account names and let the user
  choose.
- Reuse existing `sbt-relay` and `sbt-relay-blobs` resources. Do not create
  suffixed duplicates unless the existing resources belong to another project.
- Never approve a paid plan or checkout for the user.

## Verify and recover

Require the setup output to report a successful health check. Then independently
verify the printed `https://...workers.dev` URL with the repository-owned check:

```bash
npm run verify -- <relay-url>
```

The check retries for up to 30 seconds and requires JSON containing
`"ok":true`. If it fails, inspect deployment output and `npx wrangler tail`,
fix the binding or runtime error, redeploy, and retry.

Cloudflare usage notifications are optional. A custom domain or additional WAF
rule is not required for a personal relay.
