# Design — SimplySync Docs

A locked design system for the docs site (`apps/simplysync-docs/`) and its
browser demo. Every page is generated from one stylesheet, so this file is the
single source of truth: redesigns extend or amend it, they don't regenerate it
per page. The raw token values live in [`tokens.css`](./tokens.css); both
`styles.css` (docs) and `playground/styles.css` (demo) `@import` it.

## Genre

modern-minimal — developer-tool / library documentation.

## Macrostructure family

The IA is fixed and correct for reference docs; variety lives in component voice,
not page shape.

- Content pages (What/why · Client API · How it works): **Long Document** — a
  three-column shell (numbered sidebar · prose · on-this-page), generated from
  the markdown in `docs/local-first/`.
- App page (the live demo): **Workbench** — a two-device grid of cards with an
  internals inspector. Shares this system's tokens, type, and CTA voice.

## Theme — custom, dual-mode (warm)

Light is the default (`:root`); `[data-theme="dark"]` flips it. A no-flash inline
script in each `<head>` sets `data-theme` before first paint — stored choice wins,
else `prefers-color-scheme`. A sun/moon toggle in the topbar persists to
`localStorage` under `ss-theme`. The accent is the single chromatic note, kept
under ~5% of any viewport; both lightness values are tuned to pass contrast on
their own surface.

| Token | Light | Dark |
| --- | --- | --- |
| `--color-paper` | `oklch(98.6% 0.006 75)` | `oklch(17.5% 0.012 58)` |
| `--color-paper-2` | `oklch(96.3% 0.008 74)` | `oklch(21.5% 0.013 56)` |
| `--color-ink` | `oklch(24% 0.014 58)` | `oklch(92% 0.013 75)` |
| `--color-ink-2` | `oklch(43% 0.012 58)` | `oklch(73% 0.012 66)` |
| `--color-rule` | `oklch(89.5% 0.012 70)` | `oklch(31% 0.013 56)` |
| `--color-accent` | `oklch(52% 0.158 48)` | `oklch(80% 0.130 68)` |
| `--color-accent-2` (links/hover) | `oklch(45% 0.150 45)` | `oklch(86% 0.115 70)` |
| `--color-focus` | `oklch(52% 0.158 48)` | `oklch(80% 0.130 68)` |

Code panels stay dark in both modes (`--code-bg`) for classic docs contrast.

## Typography

- Display: **Space Grotesk**, weights 500/600/700, roman. Wordmark, h1–h3,
  footer statement, card titles.
- Body: **IBM Plex Sans**, weights 400/500/600.
- Mono: **IBM Plex Mono**, weights 400/500. Code, nav numerals, eyebrows,
  badges, the ciphertext/mnemonic insets.
- Display tracking: −0.02em to −0.03em. Type scale anchor:
  `--text-display = clamp(2.4rem, 1.7rem + 2.7vw, 3.35rem)`.
- One Google Fonts request, preconnected, `display=swap`, cached across pages.

## Spacing

4-point named scale (`--space-3xs` … `--space-3xl`) in `tokens.css`. Pages use
named tokens, never raw values.

## Motion

- Easings: `--ease-out` `cubic-bezier(0.16, 1, 0.3, 1)`, `--ease-in-out`.
- Reveal pattern: **none** — no scroll reveals. Only colour/opacity hover and
  focus transitions (`--dur-fast` 120ms, `--dur` 200ms).
- Reduced-motion: all transitions collapse to ≤1ms; smooth scroll disabled.

## Microinteractions stance

- Silent state changes — no celebratory toasts.
- Focus ring shows instantly (never animated), ≥3:1 contrast via `--color-focus`.
- Heading anchors fade in on hover/focus only.

## CTA voice

- Primary: solid accent fill, `--color-accent-ink` text, `--radius-sm`,
  brightness shift on hover/active. (Demo "Add", "Sync".)
- Secondary / ghost: transparent, accent text, `--color-rule` border.
- Destructive: transparent with `--color-neg` border + text.

## Per-page allowances

- Content pages: typography only — no enrichment.
- App page (demo): functional UI only — cards, badges, inspector. No enrichment.

## What pages MUST share

- The wordmark (`SimplySync` Space Grotesk 600 + a mono `DOCS` chip).
- The accent colour and its ≤5% placement.
- Display + body + mono fonts.
- The CTA voice (button shape, radius, padding rhythm).
- The light/dark token contract and the `ss-theme` toggle behaviour.

## What pages MAY differ on

- Macrostructure within the family (Long Document for content, Workbench for the
  demo) — both still use this system's type, colour, and CTA voice.

## Exports

Drop-in formats for re-using this system elsewhere. Full token set:
[`tokens.css`](./tokens.css) (light `:root` + dark `[data-theme="dark"]`).

### Tailwind v4 `@theme`

```css
@theme {
  --color-paper:   oklch(98.6% 0.006 75);
  --color-ink:     oklch(24% 0.014 58);
  --color-accent:  oklch(52% 0.158 48);
  --font-display:  "Space Grotesk", sans-serif;
  --font-body:     "IBM Plex Sans", sans-serif;
  --font-mono:     "IBM Plex Mono", monospace;
  --spacing-md:    1.5rem;
  --text-md:       1.1875rem;
  --ease-out:      cubic-bezier(0.16, 1, 0.3, 1);
}
```

### DTCG `tokens.json`

```json
{
  "color": {
    "paper":  { "$value": "oklch(98.6% 0.006 75)", "$type": "color" },
    "ink":    { "$value": "oklch(24% 0.014 58)", "$type": "color" },
    "accent": { "$value": "oklch(52% 0.158 48)", "$type": "color" }
  },
  "font": {
    "display": { "$value": "Space Grotesk", "$type": "fontFamily" },
    "body":    { "$value": "IBM Plex Sans", "$type": "fontFamily" }
  },
  "space": { "md": { "$value": "1.5rem", "$type": "dimension" } }
}
```

### shadcn/ui CSS variables (light)

```css
:root {
  --background:         98.6% 0.006 75;   /* paper */
  --foreground:         24%   0.014 58;   /* ink */
  --primary:            52%   0.158 48;   /* accent */
  --primary-foreground: 99%   0.004 75;   /* accent-ink */
  --muted:              96.3% 0.008 74;   /* paper-2 */
  --muted-foreground:   43%   0.012 58;   /* ink-2 */
  --border:             89.5% 0.012 70;   /* rule */
  --ring:               52%   0.158 48;   /* focus */
  --radius:             10px;
}
```
