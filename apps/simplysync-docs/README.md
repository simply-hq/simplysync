# @simplysync/docs

A tiny, dependency-light static docs site for the local-first library. It
renders the shared markdown in [`docs/local-first/`](../../docs/local-first/)
into themed static HTML — those `.md` files stay the single source of truth, so
edit them, not the output.

## Commands

```sh
bun run simplysync:docs        # build -> apps/simplysync-docs/dist/
bun run simplysync:docs:dev    # build, then preview on http://localhost:4200
```

From this directory you can also run `bun run build`, `bun run serve`, or
`bun run dev` directly.

## How it works

`build.ts` reads each page in `docs/local-first/`, renders it with `marked`
(GFM), adds heading anchors + an on-this-page table of contents, rewrites links
(inter-doc links → `.html`, cross-repo links → GitHub blob URLs), and wraps the
result in a dark theme (`styles.css`). Output lands in `dist/` as plain static
files plus a `404.html`.

## Hosting

`dist/` is fully static — host it on any static host:

- **Vercel:** build command `bun run simplysync:docs`, output dir
  `apps/simplysync-docs/dist`.
- **Netlify:** same build command, publish dir `apps/simplysync-docs/dist`.
- **GitHub Pages / Cloudflare Pages / S3:** upload the contents of `dist/`.

No server or runtime is required at hosting time. The only build dependency is
`marked`; no framework, no client-side JS beyond a small nav toggle.

## Adding a page

1. Add the markdown file to `docs/local-first/`.
2. Add an entry to the `pages` array in `build.ts` (`src`, `out`, `nav`).
3. Rebuild.
