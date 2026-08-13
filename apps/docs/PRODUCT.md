# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary reader is an engineer evaluating SimplySync for an application and
trying to reach a first working integration quickly. Readers may be comparing
the privacy, ownership, offline behavior, platform support, and operational
tradeoffs against hosted sync products or a custom backend.

## Product Purpose

SimplySync is open-source infrastructure for private, single-user applications.
It lets an app write to a local SQLite database first, continue working offline,
and synchronize encrypted changes between one owner's devices through an
optional relay. The public docs should let an engineer understand the boundary,
decide whether it fits, and implement it without guessing.

## Positioning

The app owns the source, schema, local database, keys, and deployment choices.
The relay only routes opaque encrypted envelopes and cannot read application
data. SimplySync is not a hosted database, cloud drive, collaboration system,
or server-authoritative backend.

## Operating Context

Readers arrive from a repository or product link, scan the architecture and fit
criteria, follow a platform-specific client guide, inspect real code and wire
artifacts, and may run the two-device TodoList demo. Supported implementation
contexts include TypeScript/React, React Native, Node, Swift, Kotlin, and a
source-owned Cloudflare relay.

## Capabilities and Constraints

- Preserve the current Bun + Marked static documentation stack; do not migrate
  the site to Next.js or another application framework.
- Markdown under `docs/local-first/` remains the factual source of truth.
- The product homepage is a finite landing page. The complete “What & why”
  Markdown begins at `/docs` and must not be spliced into the root layout.
- The browser demo remains a real bundled TodoList client rather than a staged
  mockup.
- Product claims must remain consistent with the protocol: app-owned,
  local-first, end-to-end encrypted, ciphertext-only relay, one owner across
  devices, last-write-wins by HLC, and replicated soft tombstones.
- Navigation must support long-form reading, quick evaluation, and direct access
  to the live demo, product Showcase, and SimplySync Cloud; source remains
  available in the footer.
- Light and dark presentation must remain usable, but no incumbent visual
  treatment, palette, typography, component styling, or logo is protected.

## Brand Commitments

The product name is SimplySync. The voice is direct, technical, specific, and
skeptical of hype. The user explicitly authorized a complete replacement of the
current visual identity, including the logo. The public site uses
`https://simplysync.org` as its canonical origin and keeps the SimplySync name
standalone in shared chrome. Product relationships live on `/showcase`: Simply
Finance is powered by SimplySync, while Goalist is a related local-first product
with its own sync foundation.

## Evidence on Hand

- The canonical technical and product copy lives in `README.md` and
  `docs/local-first/`.
- The working two-device browser proof lives in `apps/todolist/web/`.
- Protocol, engine, native ports, and relay implementations are present in the
  repository and must be treated as the evidence behind the documentation.
- The user supplied Simply Finance and Goalist as the two Showcase entries.
  Simply Finance's sync relationship is verified by its public privacy material
  and app-owned ports; Goalist must not be represented as using SimplySync.
- No customer logos, testimonials, adoption metrics, or performance benchmarks
  are available and none may be fabricated.

## Product Principles

1. Show the mechanism before asking for trust.
2. Make the fit and non-fit boundaries obvious.
3. Keep implementation paths short and source-verifiable.
4. Treat privacy claims as architecture to inspect, not marketing language.
5. Preserve app ownership and protocol truth across every platform guide.

## Accessibility & Inclusion

The docs and demo must remain keyboard-operable, readable under browser zoom,
responsive from narrow mobile screens through large desktops, compatible with
reduced-motion preferences, and legible in both light and dark themes.
