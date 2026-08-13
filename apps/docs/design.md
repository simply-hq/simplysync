---
name: SimplySync Docs
description: A finite product landing page paired with a quiet technical reference for private local-first sync.
colors:
  paper: "#f7f8f6"
  paper-raised: "#f0f2f1"
  ink: "#182231"
  ink-secondary: "#465363"
  ink-muted: "#667385"
  rule: "#d8dde1"
  cobalt: "#2354c6"
  cobalt-soft: "#e5ebfb"
  night-paper: "#111720"
  night-paper-raised: "#171f2a"
  night-ink: "#f1f3f6"
  night-cobalt: "#89a9ff"
typography:
  display:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "clamp(2.5rem, 1.9rem + 2.2vw, 4.25rem)"
    fontWeight: 680
    lineHeight: 1.02
    letterSpacing: "-0.04em"
  articleTitle:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "clamp(2.35rem, 1.9rem + 2vw, 3.6rem)"
    fontWeight: 730
    lineHeight: 1.02
    letterSpacing: "-0.045em"
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  control: "8px"
  panel: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
  xxl: "64px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
    height: "44px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
    height: "44px"
  nav-active:
    backgroundColor: "transparent"
    textColor: "{colors.cobalt}"
    typography: "{typography.body}"
    rounded: "0"
    padding: "10px 0"
    height: "auto"
---

# Design System: SimplySync Docs

## North star: Page Zero

SimplySync should feel like the first clear page an engineer opens before
touching a codebase: calm, exact, and immediately useful. The interface does not
stage a technical spectacle. The root gives one proposition, one inspectable
proof, a verified first command, and direct routes into the documentation — then
it ends.

The product landing and documentation are distinct surfaces. The homepage never
inherits the first documentation article or its long-form evaluation sections.
The complete “What & why” Markdown begins at `/docs` in the normal article shell.
The local-row → encrypted-envelope → local-row data path is the homepage’s sole
signature composition. Article pages and the demo become progressively quieter
so the material, not the visual system, carries attention.

### Principles

1. **Landing before documentation.** Establish the product boundary and a first
   action at `/`; keep exposition and evaluation criteria inside `/docs`.
2. **One proof is stronger than repeated motifs.** Use the real sync boundary
   once on the homepage; do not turn it into decorative scenery.
3. **Reading is the primary interaction.** Favor continuous flow, stable rhythm,
   and obvious headings over panels and dashboard chrome.
4. **Color is navigation and state.** Cobalt marks links, selection, and focus;
   semantic colors are reserved for real success, warning, and error states.
5. **Every claim must remain source-verifiable.** The site may explain the
   mechanism but never invent customer evidence, metrics, or capabilities.

## Product truth

SimplySync is open-source infrastructure for private, single-user applications.
The app owns its source, schema, local SQLite database, keys, and deployment
choices. Writes land locally first and can synchronize between one owner's
devices through an optional ciphertext-only relay. It is not a hosted database,
cloud drive, collaboration system, or server-authoritative backend.

The canonical Markdown remains the factual source. The two-device TodoList demo
remains a working client. The existing Bun + Marked static stack is part of the
implementation constraint, as are responsive behavior, keyboard operation,
reduced-motion support, and complete light and dark themes.

## Macrostructures

### Product home — Map / Diagram

The root is a finite landing page with one stable outer rail:

- a centered proposition and two actions lead at desktop widths, while the same
  source order becomes left aligned on narrow screens;
- an authentic device → relay → device figure shows readable Todo rows at both
  ends and only `eventId`, nonce, and AES-GCM ciphertext at the relay;
- a compact Quickstart excerpt is derived from the canonical React Native shell
  block, with the complete setup linked at `/docs`;
- two ruled documentation groups close the page: core concepts, then build and
  operation routes;
- the dense colophon ends the product surface without another CTA band.

The landing does not render “Use it when,” “Don’t use it when,” the component
inventory, or credits. Those belong to the complete “What & why” article. Hero,
proof, Quickstart, directory, and footer share one horizontal system, so the page
never oscillates between unrelated reading and comparison grids.

The opening is neither a dashboard nor a feature-card composition. Route rows
use rules and whitespace, not boxes. The ciphertext field may use one bounded
cobalt-tinted surface because it is a discrete technical artifact.

### Articles — Centered Reading

Documentation begins at `/docs`. Pages use one centered 46rem reading column
with a prose measure near 70 characters. A compact inline table of contents
appears near the title when useful. Global navigation remains reachable, but
there are no persistent numbered rails or three-column frames competing with
the document.

Long pages rely on descriptive headings, short introductions, sensible code
examples, and clear section spacing. Tables, callouts, and code blocks are
contained only when their structure requires it. Previous and next links form a
simple continuation at the end.

### Showcase — Catalogue

The `/showcase` page is a compact product ledger, not a customer-logo wall. It
contains one short introduction followed by two ruled product entries: Simply
Finance and Goalist. Each entry names the product, exposes its public domain,
states a source-verifiable purpose, and links directly to the site.

Product relationships are explicit rather than implied. Simply Finance is
identified as powered by SimplySync. Goalist is presented as a related
local-first product with its own sync foundation, not as a SimplySync
implementation. The page uses no invented logos, screenshots, testimonials,
metrics, or adoption claims.

### Demo — Two-Workspace

The demo leads with a short, real runbook and relay field, followed by Alice and
Bob as two calm workspaces. Owner and recovery operations remain available in a
collapsed settings row rather than preceding the experiment. Editing and
syncing stay prominent; diagnostic internals start collapsed and never visually
outrank the TodoList interactions. At narrow widths the two workspaces stack in
source order without losing any behavior.

For this proof only, background relay transports remain paused. Each device
attaches the configured relay for its explicit Sync action, then detaches again,
so the Alice → relay → Bob sequence has visible cause and effect. Todo rows keep
immutable creation order through edits and completion changes, and the checkbox
label includes the title without making Edit or Delete part of that hit area.
Loading the sample twice must not create duplicate rows.

The demo must continue to expose real state: local edits, manual synchronization,
relay configuration, owner recovery, counts, and recent events. Visual restraint
must not hide operational truth.

## Identity

The wordmark uses the native system UI stack. The mark is a single-color,
mask-safe glyph: two offset angular paths repeating the same sync rhythm. It
suggests two owned copies converging on the same state without literal arrows,
shuffle symbols, or a network diagram. The glyph takes the theme's cobalt
through the CSS mask and remains legible at 16–28px.

The header uses the SimplySync mark and wordmark alone. Product relationships
live on `/showcase` rather than following the identity through every route. The
same standalone wordmark appears on the demo, and `https://simplysync.org` is
the canonical public origin.

Do not place the identity inside a badge, gradient field, or logo tile. The mark
and wordmark sit directly on the page.

## Color

Cool paper neutrals make up nearly the entire interface. Deep blue-black ink
provides contrast without a pure-black glare. Cobalt is the only brand accent and
should occupy less than roughly five percent of a typical viewport.

- **Paper / raised paper:** page and occasional contained technical surfaces.
- **Ink / secondary / muted:** primary reading, supporting text, and metadata.
- **Rule:** quiet structure between routes, sections, and data rows.
- **Cobalt:** links, current location, focus, and a small number of decisive
  interactive states.
- **Semantic red, amber, and green:** only real error, caution, and success.

Dark mode preserves the same hierarchy rather than merely inverting values.
Paper becomes a deep blue-black, rules remain visible, body text stays below pure
white, and cobalt gains luminance so links and focus retain contrast.

## Typography

The system UI stack is used for both display and prose. Familiar platform
letterforms make the docs feel like a dependable reference and satisfy the
product requirement for a system font. Headings use weight, scale, and spacing;
there is no decorative typeface or all-caps micro-label layer.

The system monospace stack is restricted to commands, code, identifiers,
timestamps, counters, and serialized data. It is not used to make ordinary copy
look technical.

- Page titles are compact, sentence case, and left aligned.
- Body text sits at a comfortable reading size with a 1.6–1.7 line height.
- Section headings are descriptive and separated by space rather than ornamental
  rules or eyebrows.
- Link styling remains visible in prose and does not depend on color alone.

## Space, shape, and depth

The layout follows a four-pixel spacing basis with larger intervals of 16, 24,
40, and 64px. Empty space groups related content and replaces most container
chrome. Sections may use a single quiet rule when adjacency would otherwise be
ambiguous.

Controls use moderate 8px corners and at least a 44px hit area. Technical fields
may use 10px corners. Avoid excessive pills; reserve them for compact state when
shape genuinely helps recognition.

The interface is flat. There are no gradients, ambient shadows, glass effects,
textured backgrounds, glowing borders, or ornamental blobs. A mobile navigation
drawer may cast a restrained shadow because it is a real overlay.

## Navigation and footer

The N9 Edge-aligned minimal navigation contains only the product identity and
essential destinations: Docs, Demo, Showcase, SimplySync Cloud, menu on
documentation pages when needed, and theme. Source remains in the footer
instead of competing in the topbar. It should feel like the top edge of a
document, not an application toolbar. The demo chrome repeats the Cloud action
beside its theme control.

The Ft4 Dense typographic footer is a compact, left-anchored colophon. It aligns
with the wider landing rail at `/` and the reading column inside articles. The
first row describes SimplySync on its own terms as app-owned, encrypted sync
infrastructure. A tightly grouped second row contains the license context,
Showcase and Cloud routes, and wrapping resource navigation; metadata is never
pushed to opposite edges. The adjacent-page rule is the page ending's only
separator. The footer does not repeat the route index, add a newsletter, repeat
the logo, or become a multi-column marketing footer.

## Interaction and motion

Every interactive state remains apparent through contrast, underline, border,
or focus outline. Keyboard focus uses a visible cobalt ring with enough offset
to avoid clipping. Hover states are quiet previews of activation, not movement
or transformation.

Transitions are limited to short color and opacity changes around 120ms. Theme
and menu state remain immediate and predictable. Under `prefers-reduced-motion`,
non-essential transitions are removed. There is no scroll theater, staggered
reveal, diagram animation, or ambient motion.

## Do / do not

### Do

- let route names, headings, real code, and protocol artifacts carry interest;
- make fit and non-fit boundaries easy to find;
- preserve generous reading rhythm and direct language;
- keep behavior and information order stable across viewport sizes;
- verify contrast and focus in both themes.

### Do not

- use cards as the default unit of composition;
- add gradients, shadows, glass, glows, noise, or decorative illustration;
- repeat the row/envelope/row signature outside its homepage proof;
- add numbered side rails, uppercase eyebrow labels, or control-board notation;
- use cobalt as a large background fill or as fake technical decoration;
- hide important demo behavior to make the interface look cleaner.
