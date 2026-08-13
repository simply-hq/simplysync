---
version: 1
slug: "styles-css"
primary_target: "styles.css"
related_targets: ["build.ts","tokens.css","simplysync-mark.svg"]
---

## Scope and mode

Public documentation site and bundled browser demo. Visitor mode: Read, then
operate in the demo.

## Audience and job

An engineer evaluating SimplySync needs to understand the ownership and trust
boundary, decide whether its single-owner local-first model fits, choose a
platform route, and reach a working implementation without decoding the site's
design.

## Action, proof, and constraints

Primary action: start integrating from the finite product landing page.
Secondary actions: open the documentation, inspect the live two-device demo,
open the product Showcase, and choose a concept or implementation route. The
decisive proof is one authentic SQLite row → encrypted envelope → SQLite row
data path, supported by the canonical Quickstart excerpt and the functioning
demo.

Keep the Bun + Marked static builder, canonical Markdown content, demo behavior,
responsive behavior, keyboard access, reduced-motion support, and complete light
and dark themes. The UI uses the native system font; monospace is restricted to
code and data.

## Chosen direction

Page Zero now uses a dedicated Map / Diagram landing composition: a slim
edge-aligned header, a centered proposition, one inspectable device → relay →
device proof, a compact canonical Quickstart excerpt, and two ruled
documentation groups. The root ends after its colophon. The complete “What &
why” Markdown renders separately at `/docs`; no long-form article sections are
spliced beneath the landing page.

Landing proof, Quickstart, route directory, and footer share one outer rail.
Only equivalent route groups split into columns, and the proof becomes
horizontal only when all three stages remain readable. Article pages use a
centered reading column and compact inline table of contents.
The demo uses a short manual-sync runbook and relay field above two quiet
workspaces. Owner and recovery controls sit in a collapsed settings row, sample
loading is idempotent, todo order stays stable, and internals remain collapsed
by default. Article endings use labelled adjacent-page
links followed by a two-row typographic colophon aligned to the reading column.

Cool paper and deep blue-black ink carry almost the entire surface. Cobalt is a
sparse navigational and focus accent. Structure comes from whitespace and quiet
rules, not cards, shadows, gradients, glass, numbered rails, or uppercase eyebrow
labels. The single-color mark uses two offset angular paths to repeat one sync
rhythm and stays cobalt in both docs and demo chrome.
The compact wordmark stands alone in both the docs and demo headers. A dedicated
`/showcase` product ledger carries the Simply Finance and Goalist relationships
without turning every route into parent-brand chrome. Showcase joins the
desktop docs topbar and compact footer; Cloud remains the narrow-screen topbar
action on the demo, while the docs shell gives that compact slot to Showcase.
Cloud remains available in the docs drawer and footer, and Source stays in the
footer. The footer identifies SimplySync independently, then keeps the license
and project resources together as one compact left-anchored colophon.

## Unresolved decisions

None. The product/docs route split, Map / Diagram landing, system typography,
dual-theme palette, identity intent, homepage signature proof, and low-noise
exclusions are recorded in `design.md`.
