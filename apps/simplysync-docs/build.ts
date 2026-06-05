import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

// Renders the shared markdown in docs/local-first/ into a small, dependency-light
// static site (dist/). The markdown files stay the single source of truth — this
// builder only themes them and rewires links for the web.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const docsDir = join(repoRoot, "docs", "local-first");
const distDir = join(here, "dist");

// Cross-repo links (../../packages/…, ../../apps/…) resolve to GitHub once merged.
const REPO_BLOB_BASE =
  "https://github.com/simply-hq/simplysync/blob/main";

const SITE_TITLE = "Local-First";

interface Page {
  readonly src: string; // file in docsDir
  readonly out: string; // file in dist
  readonly nav: string; // sidebar label
}

const pages: readonly Page[] = [
  { src: "README.md", out: "index.html", nav: "Overview" },
  { src: "guide.md", out: "guide.html", nav: "User Guide" },
  { src: "architecture.md", out: "architecture.html", nav: "Architecture" },
];

// Map a source markdown basename to its built page (for inter-doc links).
const pageByMarkdown = new Map(
  pages.map((page) => [page.src.toLowerCase(), page.out]),
);

interface TocEntry {
  readonly level: number;
  readonly id: string;
  readonly text: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "") // drop inline tags
    .replace(/&[a-z]+;/g, "") // drop entities
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
}

/** Adds stable ids to h2/h3 headings and collects a table of contents. */
function addHeadingAnchors(html: string): { html: string; toc: TocEntry[] } {
  const toc: TocEntry[] = [];
  const used = new Set<string>();

  const withIds = html.replace(
    /<h([23])>([\s\S]*?)<\/h\1>/g,
    (_match, levelRaw: string, inner: string) => {
      const level = Number(levelRaw);
      const text = stripTags(inner).trim();
      let id = slugify(text) || "section";
      let suffix = 1;
      while (used.has(id)) id = `${slugify(text)}-${++suffix}`;
      used.add(id);
      toc.push({ level, id, text });
      return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${level}>`;
    },
  );

  return { html: withIds, toc };
}

function rewriteHref(href: string): string {
  if (/^(https?:|mailto:|#)/.test(href)) return href;

  const [path, hash = ""] = href.split("#");
  const anchor = hash ? `#${hash}` : "";
  const cleaned = path.replace(/^\.\//, "");

  // Inter-doc links → built html pages.
  const mapped = pageByMarkdown.get(cleaned.toLowerCase());
  if (mapped) return `${mapped}${anchor}`;

  // Other repo-relative links → GitHub blob (resolved against docs/local-first).
  if (path.includes("..") || path.endsWith(".md")) {
    const resolved = posix.normalize(posix.join("docs/local-first", path));
    return `${REPO_BLOB_BASE}/${resolved}${anchor}`;
  }

  return href;
}

function rewriteLinks(html: string): string {
  return html.replace(
    /href="([^"]+)"/g,
    (_match, href: string) => `href="${rewriteHref(href)}"`,
  );
}

function firstHeading(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : SITE_TITLE;
}

function renderNav(activeOut: string): string {
  const items = pages
    .map((page) => {
      const active = page.out === activeOut ? ' class="active"' : "";
      return `<a href="${page.out}"${active}>${page.nav}</a>`;
    })
    .join("\n        ");
  return items;
}

function renderToc(toc: TocEntry[]): string {
  if (toc.length === 0) return "";
  const items = toc
    .map(
      (entry) =>
        `<a class="toc-l${entry.level}" href="#${entry.id}">${entry.text}</a>`,
    )
    .join("\n        ");
  return `<nav class="toc" aria-label="On this page">
        <p class="toc-title">On this page</p>
        ${items}
      </nav>`;
}

function layout(options: {
  title: string;
  activeOut: string;
  content: string;
  toc: TocEntry[];
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${options.title} · ${SITE_TITLE} Docs</title>
  <meta name="description" content="Docs for the app-owned, end-to-end-encrypted local-first library." />
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <a class="skip-link" href="#content">Skip to content</a>
  <header class="topbar">
    <button class="menu-toggle" aria-label="Toggle navigation" onclick="document.body.classList.toggle('nav-open')">☰</button>
    <a class="brand" href="index.html">${SITE_TITLE} <span>Docs</span></a>
    <a class="repo-link" href="${REPO_BLOB_BASE}/packages/simplysync-core">Source ↗</a>
  </header>
  <div class="shell">
    <aside class="sidebar" aria-label="Sections">
      <nav class="nav">
        ${renderNav(options.activeOut)}
      </nav>
    </aside>
    <main id="content" class="content">
      <article class="prose">
        ${options.content}
      </article>
    </main>
    <div class="toc-col">
      ${renderToc(options.toc)}
    </div>
  </div>
  <div class="nav-scrim" onclick="document.body.classList.remove('nav-open')"></div>
</body>
</html>
`;
}

async function build(): Promise<void> {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  marked.setOptions({ gfm: true });

  for (const page of pages) {
    const markdown = await readFile(join(docsDir, page.src), "utf8");
    const rendered = await marked.parse(markdown);
    const { html: withAnchors, toc } = addHeadingAnchors(rendered);
    const content = rewriteLinks(withAnchors);
    const html = layout({
      title: firstHeading(markdown),
      activeOut: page.out,
      content,
      toc,
    });
    await writeFile(join(distDir, page.out), html, "utf8");
    console.log(`  ${page.src} → dist/${page.out}`);
  }

  await writeFile(
    join(distDir, "styles.css"),
    await readFile(join(here, "styles.css"), "utf8"),
    "utf8",
  );
  // SPA-style hosts (and GitHub Pages) need a sensible 404; reuse the overview.
  await writeFile(
    join(distDir, "404.html"),
    await readFile(join(distDir, "index.html"), "utf8"),
    "utf8",
  );

  console.log(`\nBuilt ${pages.length} pages → ${distDir}`);
}

await build();
