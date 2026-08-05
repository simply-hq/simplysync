import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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
const todoWebDir = join(repoRoot, "apps", "todolist", "web");

// Cross-repo links (../../packages/…, ../../apps/…) resolve to GitHub once merged.
const REPO_BLOB_BASE =
  "https://github.com/simply-hq/simplysync/blob/main";

const SITE_TITLE = "SimplySync";

// One web-font request (Space Grotesk display · IBM Plex Sans body · IBM Plex
// Mono code), preconnected and cached across every page.
const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap" />`;

// Sets data-theme before first paint to avoid a flash: stored choice wins,
// otherwise follow the OS preference.
const THEME_SCRIPT = `<script>(function(){try{var t=localStorage.getItem("ss-theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",t);}catch(e){}})();</script>`;

// Toggle: flip data-theme on <html> and persist. Inline so it works on the
// static pages with no bundle.
const THEME_TOGGLE = `<button class="theme-toggle" type="button" aria-label="Toggle dark mode" onclick="(function(d){var n=d.getAttribute('data-theme')==='dark'?'light':'dark';d.setAttribute('data-theme',n);try{localStorage.setItem('ss-theme',n)}catch(e){}})(document.documentElement)"><span class="t-sun" aria-hidden="true">☀</span><span class="t-moon" aria-hidden="true">☾</span></button>`;

interface LangTab {
  readonly label: string; // tab label (React / Swift / Kotlin)
  readonly out: string; // page the tab links to
}

interface Page {
  readonly src: string; // file in docsDir
  readonly out: string; // file in dist
  readonly nav: string; // sidebar label
  // A language switcher rendered above the prose (Client API variants share one).
  readonly langTabs?: readonly LangTab[];
  // Which sidebar entry to highlight; defaults to `out`. Variant pages point at
  // their primary so the single sidebar entry stays active across the tabs.
  readonly navActive?: string;
}

// The Client API page ships in three language variants. Only the React one sits
// in the numbered sidebar; all three render this switcher and link to each other.
const CLIENT_API_TABS: readonly LangTab[] = [
  { label: "React", out: "guide.html" },
  { label: "Swift", out: "guide-swift.html" },
  { label: "Kotlin", out: "guide-kotlin.html" },
];

const pages: readonly Page[] = [
  { src: "README.md", out: "index.html", nav: "What & why" },
  { src: "guide.md", out: "guide.html", nav: "Client API", langTabs: CLIENT_API_TABS },
  { src: "architecture.md", out: "architecture.html", nav: "How it works" },
  { src: "sync.md", out: "sync.html", nav: "Sync & relay" },
  { src: "native.md", out: "native.html", nav: "Native clients" },
  { src: "self-hosting.md", out: "self-hosting.html", nav: "Self-hosting" },
  { src: "agents.md", out: "agents.html", nav: "For agents" },
];

// Language variants of the Client API: built and cross-linked via the switcher,
// but not given their own sidebar slot — they highlight "Client API".
const variantPages: readonly Page[] = [
  { src: "guide.swift.md", out: "guide-swift.html", nav: "Client API", langTabs: CLIENT_API_TABS, navActive: "guide.html" },
  { src: "guide.kotlin.md", out: "guide-kotlin.html", nav: "Client API", langTabs: CLIENT_API_TABS, navActive: "guide.html" },
];

// Every page that gets rendered (sidebar pages + the hidden language variants).
const allPages: readonly Page[] = [...pages, ...variantPages];

// Map a source markdown basename to its built page (for inter-doc links).
const pageByMarkdown = new Map(
  allPages.map((page) => [page.src.toLowerCase(), page.out]),
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
  // The docs are deliberately ordinal, so the sidebar numbers the sections
  // rather than presenting a flat list.
  const items = pages
    .map((page, i) => {
      const active = page.out === activeOut ? " active" : "";
      const idx = String(i + 1).padStart(2, "0");
      return `<a class="nav-link${active}" href="${page.out}"><span class="n-idx">${idx}</span><span>${page.nav}</span></a>`;
    })
    .join("\n        ");
  // The demo is a bundled SPA, not a markdown page, so it's appended here
  // rather than living in `pages`.
  return `<p class="nav-label">Documentation</p>
        ${items}
        <a class="nav-demo" href="demo.html">Live demo</a>`;
}

// A segmented control above the prose that switches the Client API page between
// its language variants. The active tab is inert text; the others are links.
function renderLangTabs(
  tabs: readonly LangTab[],
  activeOut: string,
): string {
  const items = tabs
    .map((tab) =>
      tab.out === activeOut
        ? `<span class="lang-tab active" aria-current="page">${tab.label}</span>`
        : `<a class="lang-tab" href="${tab.out}">${tab.label}</a>`,
    )
    .join("");
  return `<div class="lang-tabs" role="tablist" aria-label="Client language">${items}</div>`;
}

function renderFooter(): string {
  return `<footer class="site-footer">
      <div class="footer-inner">
        <p class="footer-statement">Local-first. <em>End-to-end encrypted.</em> App-owned — no data hostage.</p>
        <nav class="footer-links" aria-label="Resources">
          <a href="index.html">What &amp; why</a>
          <a href="guide.html">Client API</a>
          <a href="architecture.html">How it works</a>
          <a href="sync.html">Sync &amp; relay</a>
          <a href="native.html">Native clients</a>
          <a href="demo.html">Live demo</a>
          <a href="${REPO_BLOB_BASE}/packages/simplysync-protocol">Source ↗</a>
        </nav>
        <p class="footer-meta">MIT-licensed. Clone it, run your own relay, depend on no one. The relay only ever sees ciphertext.</p>
      </div>
    </footer>`;
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
  activeOut: string; // sidebar highlight
  content: string;
  toc: TocEntry[];
  langTabs?: readonly LangTab[];
  langActiveOut?: string; // which language tab is active
}): string {
  const langBar = options.langTabs
    ? renderLangTabs(options.langTabs, options.langActiveOut ?? options.activeOut)
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${options.title} · ${SITE_TITLE} Docs</title>
  <meta name="description" content="Docs for the app-owned, end-to-end-encrypted local-first library." />
  ${THEME_SCRIPT}
  ${FONT_LINKS}
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <a class="skip-link" href="#content">Skip to content</a>
  <header class="topbar">
    <button class="menu-toggle" aria-label="Toggle navigation" onclick="document.body.classList.toggle('nav-open')">☰</button>
    <a class="brand" href="index.html">${SITE_TITLE} <span>Docs</span></a>
    <span class="topbar-spacer"></span>
    <a class="repo-link" href="${REPO_BLOB_BASE}/packages/simplysync-protocol">Source ↗</a>
    ${THEME_TOGGLE}
  </header>
  <div class="shell">
    <aside class="sidebar" aria-label="Sections">
      <nav class="nav">
        ${renderNav(options.activeOut)}
      </nav>
    </aside>
    <main id="content" class="content">
      <article class="prose">
        ${langBar}
        ${options.content}
      </article>
    </main>
    <div class="toc-col">
      ${renderToc(options.toc)}
    </div>
    ${renderFooter()}
  </div>
  <div class="nav-scrim" onclick="document.body.classList.remove('nav-open')"></div>
</body>
</html>
`;
}

// The agent-readable views of these same docs (llmstxt.org): llms.txt is the
// index a crawler reads first, llms-full.txt the whole corpus in one fetch so an
// agent needs no crawl at all. Generated from the markdown, so they can't drift.
// The order is deliberate — the contract an agent must not violate comes first.
const LLMS_ORDER: readonly string[] = [
  "agents.md",
  "README.md",
  "guide.md",
  "architecture.md",
  "sync.md",
  "native.md",
  "self-hosting.md",
  "guide.swift.md",
  "guide.kotlin.md",
];

function llmsIndex(): string {
  const entries = LLMS_ORDER.map((src) => {
    const page = allPages.find((p) => p.src === src);
    if (!page) return null;
    // The three Client API variants share one nav label, so qualify them by
    // language — an index of three identical entries is useless to a crawler.
    const tab = page.langTabs?.find((t) => t.out === page.out);
    const label = tab ? `${page.nav} (${tab.label})` : page.nav;
    return `- [${label}](${page.out})`;
  })
    .filter(Boolean)
    .join("\n");
  return `# SimplySync

> App-owned, end-to-end-encrypted, local-first sync: apps write to a local
> SQLite database first and sync opportunistically through a relay that only
> ever sees ciphertext. One protocol, four implementations (TypeScript, Go,
> Kotlin, Swift), all wire-compatible.

For single-user apps across a person's own devices — notes, journals, personal
finance, health trackers, local AI chat. Not for live multi-user collaboration,
teams and sharing, or server-side reads of user data: conflicts resolve
row-level last-write-wins, and the relay cannot decrypt anything.

Start with "For agents" — it is the dense contract for writing correct app code.
Fetch llms-full.txt for every page below in a single request.

## Docs
${entries}
- [Everything, concatenated](llms-full.txt)
`;
}

function demoHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Demo · ${SITE_TITLE}</title>
  <meta name="description" content="Run the SimplySync local-first, end-to-end-encrypted engine in your browser." />
  ${THEME_SCRIPT}
  ${FONT_LINKS}
  <link rel="stylesheet" href="demo.css" />
</head>
<body>
  <div class="pg-topnav">
    <a class="pg-back" href="index.html">← Docs</a>
    ${THEME_TOGGLE}
  </div>
  <div id="app"></div>
  <script type="module" src="demo.js"></script>
</body>
</html>
`;
}

// Bundles the React demo SPA into dist/ with Bun's bundler (no extra toolchain),
// copies sql.js's wasm next to it, and emits the host HTML. The TodoList web app
// lives with the other clients under apps/todolist/web.
async function buildDemo(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(todoWebDir, "main.tsx")],
    outdir: distDir,
    target: "browser",
    minify: true,
    sourcemap: "none",
    naming: { entry: "demo.[ext]" },
    // React (and other libs) branch on this; browsers have no `process`.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Demo bundle failed.");
  }

  // sql.js fetches its wasm at runtime via locateFile(() => "sql-wasm.wasm").
  await copyFile(
    Bun.resolveSync("sql.js/dist/sql-wasm.wasm", here),
    join(distDir, "sql-wasm.wasm"),
  );
  await copyFile(
    join(todoWebDir, "styles.css"),
    join(distDir, "demo.css"),
  );
  await writeFile(join(distDir, "demo.html"), demoHtml(), "utf8");
  console.log("  apps/todolist/web → dist/demo.{js,html,css} (+ wasm)");
}

async function build(): Promise<void> {
  const markdownFiles = (await readdir(docsDir))
    .filter((file) => file.endsWith(".md"))
    .sort();
  const renderedFiles = new Set(allPages.map((page) => page.src));
  const indexedFiles = new Set(LLMS_ORDER);
  const notRendered = markdownFiles.filter((file) => !renderedFiles.has(file));
  const notIndexed = markdownFiles.filter((file) => !indexedFiles.has(file));
  const unknownIndexed = LLMS_ORDER.filter(
    (file) => !renderedFiles.has(file),
  );
  if (
    notRendered.length > 0 ||
    notIndexed.length > 0 ||
    unknownIndexed.length > 0
  ) {
    throw new Error(
      [
        notRendered.length > 0
          ? `docs missing from the site: ${notRendered.join(", ")}`
          : "",
        notIndexed.length > 0
          ? `docs missing from llms-full.txt: ${notIndexed.join(", ")}`
          : "",
        unknownIndexed.length > 0
          ? `unknown docs in LLMS_ORDER: ${unknownIndexed.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("; "),
    );
  }

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  marked.setOptions({ gfm: true });

  const sources = new Map<string, string>();

  for (const page of allPages) {
    const markdown = await readFile(join(docsDir, page.src), "utf8");
    sources.set(page.src, markdown);
    const rendered = await marked.parse(markdown);
    const { html: withAnchors, toc } = addHeadingAnchors(rendered);
    const content = rewriteLinks(withAnchors);
    const html = layout({
      title: firstHeading(markdown),
      activeOut: page.navActive ?? page.out, // sidebar highlight
      langTabs: page.langTabs,
      langActiveOut: page.out, // active tab is this page
      content,
      toc,
    });
    await writeFile(join(distDir, page.out), html, "utf8");
    console.log(`  ${page.src} → dist/${page.out}`);
  }

  // styles.css and demo.css both @import this shared token layer.
  await writeFile(
    join(distDir, "tokens.css"),
    await readFile(join(here, "tokens.css"), "utf8"),
    "utf8",
  );
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

  await writeFile(join(distDir, "llms.txt"), llmsIndex(), "utf8");
  const corpus = LLMS_ORDER.map((src) => sources.get(src))
    .filter((markdown): markdown is string => Boolean(markdown))
    .join("\n\n---\n\n");
  await writeFile(join(distDir, "llms-full.txt"), corpus, "utf8");
  console.log("  docs/local-first/*.md → dist/llms{,-full}.txt");

  await buildDemo();

  console.log(`\nBuilt ${allPages.length} pages + demo → ${distDir}`);
}

await build();
