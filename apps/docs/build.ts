import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { createHighlighter, type Highlighter } from "shiki";

// Renders the shared markdown in docs/local-first/ into a small, dependency-light
// static site (dist/). The markdown files stay the single source of truth — this
// builder only themes them and rewires links for the web.

// Code blocks are dark in BOTH site themes (see --code-bg in tokens.css), so a
// single dark grammar theme is all this needs — no dual-theme CSS, no runtime
// switch. Highlighting happens here at build time: the browser gets plain
// styled spans and downloads no highlighter.
const CODE_THEME = "github-dark";

// Languages the docs actually fence. An unlisted language renders unhighlighted
// rather than throwing, so adding a fence never breaks the build.
const CODE_LANGS = [
  "ts",
  "tsx",
  "js",
  "swift",
  "kotlin",
  "go",
  "sh",
  "bash",
  "json",
  "jsonc",
  "sql",
  "html",
  "css",
] as const;

const LANG_ALIASES: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  shell: "sh",
  console: "sh",
  text: "",
  txt: "",
};

let highlighter: Highlighter | null = null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Diagrams are SVG files beside the markdown (docs/local-first/images/), so
// GitHub renders them as ordinary images. The site INLINES them instead of
// linking: an <img> can't see the page's CSS, so it would follow the OS colour
// scheme rather than the site's own light/dark toggle. Inlining also drops the
// file's standalone <style> (the GitHub colours) and lets tokens.css colour the
// same classes. Keyed by file name, loaded once per build.
const diagrams = new Map<string, { svg: string; desc: string }>();

async function loadDiagrams(dir: string): Promise<void> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".svg"));
  } catch {
    return; // no images directory yet
  }
  for (const name of names) {
    const raw = await readFile(join(dir, name), "utf8");
    const desc = /<desc>([\s\S]*?)<\/desc>/.exec(raw)?.[1]?.trim() ?? "";
    const svg = raw
      .replace(/<\?xml[\s\S]*?\?>\s*/, "")
      .replace(/<style>[\s\S]*?<\/style>\s*/, "")
      // Size from CSS, not the file's intrinsic width, so it fits the column.
      .replace(/(<svg\b[^>]*?)\s+width="[^"]*"/, "$1")
      .replace(/(<svg\b[^>]*?)\s+height="[^"]*"/, "$1")
      .trim();
    diagrams.set(name, { svg, desc });
  }
}

// marked renders `![alt](./images/x.svg "caption")` as an <img> in its own
// paragraph. Swap that for a figure holding the inline SVG; the markdown alt
// becomes the accessible name and the optional title becomes the caption.
function inlineDiagrams(html: string, page: string): string {
  return html.replace(
    /<p><img src="(?:\.\/)?images\/([a-z0-9-]+\.svg)" alt="([^"]*)"(?: title="([^"]*)")?\s*\/?><\/p>/g,
    (_match, name: string, alt: string, title?: string) => {
      const diagram = diagrams.get(name);
      if (!diagram) throw new Error(`${page} references missing diagram images/${name}`);
      const svg = diagram.svg.replace(
        /aria-label="[^"]*"/,
        `aria-label="${alt}"`,
      );
      const caption = title ? `\n  <figcaption>${title}</figcaption>` : "";
      return `<figure class="diagram">\n  ${svg}${caption}\n</figure>`;
    },
  );
}

// For llms-full.txt: an agent reading the raw markdown would get only the alt
// text where an ASCII diagram used to carry the whole structure. Substitute the
// SVG's <desc> — the prose version of the same picture.
function describeDiagrams(markdown: string): string {
  return markdown.replace(
    /!\[([^\]]*)\]\((?:\.\/)?images\/([a-z0-9-]+\.svg)(?: "[^"]*")?\)/g,
    (match, alt: string, name: string) => {
      const desc = diagrams.get(name)?.desc;
      return desc ? `[Diagram: ${alt}] ${desc}` : match;
    },
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const docsDir = join(repoRoot, "docs", "local-first");
const distDir = join(here, "dist");
const todoWebDir = join(repoRoot, "apps", "todolist", "web");

// Cross-repo links (../../packages/…, ../../apps/…) resolve to GitHub once merged.
const REPO_BLOB_BASE =
  "https://github.com/simply-hq/simplysync/blob/main";

const SITE_TITLE = "SimplySync";
const SITE_ORIGIN = "https://simplysync.org";
const SITE_DESCRIPTION =
  "Documentation for SimplySync, the app-owned, end-to-end-encrypted local-first sync engine.";
const OG_SITE_NAME = "SimplySync";
const SIMPLY_FINANCE_URL = "https://simplyfinance.app/";
const GOALIST_URL = "https://goalist.app/";
const SIMPLYSYNC_CLOUD_URL = "https://cloud.simplysync.org/";
const BRAND_MARK = `<span class="brand-mark" aria-hidden="true"></span>`;

// Sets data-theme before first paint to avoid a flash: stored choice wins,
// otherwise follow the OS preference.
const THEME_SCRIPT = `<script>(function(){try{var t=localStorage.getItem("ss-theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",t);}catch(e){}})();</script>`;

// Toggle: flip data-theme on <html> and persist. Inline so it works on the
// static pages with no bundle.
const THEME_TOGGLE = `<button class="theme-toggle" type="button" aria-label="Switch colour theme" onclick="window.ssToggleTheme(this)"><svg class="t-sun" aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.25"/><path d="M10 1.75v2M10 16.25v2M1.75 10h2M16.25 10h2M4.17 4.17l1.42 1.42M14.41 14.41l1.42 1.42M15.83 4.17l-1.42 1.42M5.59 14.41l-1.42 1.42"/></svg><svg class="t-moon" aria-hidden="true" viewBox="0 0 20 20"><path d="M16.45 12.64A7 7 0 0 1 7.36 3.55a7 7 0 1 0 9.09 9.09Z"/></svg></button>`;

const MENU_TOGGLE = `<button class="menu-toggle" type="button" aria-label="Open documentation navigation" aria-controls="docs-sidebar" aria-expanded="false" onclick="window.ssToggleNav()"><svg aria-hidden="true" viewBox="0 0 20 20"><path d="M3 5.5h14M3 10h14M3 14.5h14"/></svg></button>`;

// Progressive enhancement only: the pages remain fully navigable without it.
// The script manages the mobile drawer, theme label, and a light scrollspy for
// the on-this-page rail while keeping the static build dependency-free.
const SITE_SCRIPT = `<script>(function(){
  var root=document.documentElement,body=document.body,menu=document.querySelector('.menu-toggle');
  window.ssToggleTheme=function(button){var next=root.getAttribute('data-theme')==='dark'?'light':'dark';root.setAttribute('data-theme',next);button.setAttribute('aria-label','Switch to '+(next==='dark'?'light':'dark')+' theme');try{localStorage.setItem('ss-theme',next)}catch(e){}};
  window.ssToggleNav=function(force){var open=typeof force==='boolean'?force:!body.classList.contains('nav-open');body.classList.toggle('nav-open',open);if(menu){menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'Close documentation navigation':'Open documentation navigation');}};
  var themeButton=document.querySelector('.theme-toggle');if(themeButton){themeButton.setAttribute('aria-label','Switch to '+(root.getAttribute('data-theme')==='dark'?'light':'dark')+' theme');}
  document.addEventListener('keydown',function(event){if(event.key==='Escape')window.ssToggleNav(false)});
  document.addEventListener('click',function(event){var target=event.target;if(target&&target.closest&&target.closest('.nav-sub-link'))window.ssToggleNav(false)});
  var links=Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if('IntersectionObserver' in window&&links.length){var byId=new Map(links.map(function(link){return[link.getAttribute('href').slice(1),link]}));var subs=Array.prototype.slice.call(document.querySelectorAll('.nav-sub-link'));var setCurrent=function(id){links.forEach(function(link){var active=link===byId.get(id);link.classList.toggle('current',active);if(active)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current')});var rail=byId.get(id);var section=rail?rail.getAttribute('data-section'):id;subs.forEach(function(link){link.classList.toggle('current',link.getAttribute('data-nav-section')===section)})};var observer=new IntersectionObserver(function(entries){entries.forEach(function(entry){if(entry.isIntersecting)setCurrent(entry.target.id)})},{rootMargin:'-18% 0px -68% 0px'});byId.forEach(function(_link,id){var heading=document.getElementById(id);if(heading)observer.observe(heading)});setCurrent(links[0].getAttribute('href').slice(1));}
})();</script>`;

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
  { src: "README.md", out: "docs.html", nav: "What & why" },
  { src: "guide.md", out: "guide.html", nav: "Client API", langTabs: CLIENT_API_TABS },
  { src: "schema.md", out: "schema.html", nav: "Schema evolution" },
  { src: "architecture.md", out: "architecture.html", nav: "How it works" },
  { src: "sync.md", out: "sync.html", nav: "Sync & relay" },
  { src: "native.md", out: "native.html", nav: "Native clients" },
  { src: "icloud.md", out: "icloud.html", nav: "iCloud sync" },
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

// A nav item is either a page (by its built filename) or a shortcut into one.
// Shortcuts exist for the things people come back to look up, so "where's the
// signature for restoreAppOwner?" is one click from anywhere, not a scroll.
type NavItem = string | { readonly label: string; readonly anchor: string };

const NAV_GROUPS: readonly { label: string; pages: readonly NavItem[] }[] = [
  { label: "Start", pages: ["docs.html", "guide.html", "schema.html", "architecture.html"] },
  { label: "Operate", pages: ["sync.html", "native.html", "icloud.html", "self-hosting.html"] },
  {
    label: "Reference",
    pages: [
      { label: "API reference", anchor: "api-reference" },
      { label: "Common pitfalls", anchor: "common-pitfalls" },
      "agents.html",
    ],
  },
];

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
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&");
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
      return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}</h${level}>`;
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

function canonicalUrl(out: string): string {
  const cleanPath = out === "index.html" ? "" : out.replace(/\.html$/, "");
  return `${SITE_ORIGIN}/${cleanPath}`;
}

// The active page unfolds into its top-level sections, Evolu-style. Only h2s:
// the "On this page" rail carries the full outline on wide screens, and this is
// the only section list a phone gets, since the rail is hidden there. Links are
// same-page anchors, so a Client API variant lists its own sections even though
// the sidebar entry it highlights is the shared "Client API".
function renderNavSections(toc: readonly TocEntry[]): string {
  const sections = toc.filter((entry) => entry.level === 2);
  if (sections.length < 2) return "";
  const links = sections
    .map(
      (entry) =>
        `<a class="nav-sub-link" data-nav-section="${entry.id}" href="#${entry.id}">${entry.text}</a>`,
    )
    .join("\n              ");
  return `
            <div class="nav-sub" role="group" aria-label="Sections on this page">
              ${links}
            </div>`;
}

function renderNav(
  activeOut: string,
  currentOut = activeOut,
  toc: readonly TocEntry[] = [],
): string {
  // Shortcuts land in the Client API variant you are already reading, so a
  // Swift developer's "API reference" opens the Swift table, not the React one.
  const apiPage = CLIENT_API_TABS.some((tab) => tab.out === currentOut)
    ? currentOut
    : "guide.html";
  const groups = NAV_GROUPS.map((group) => {
    const items = group.pages
      .map((item) => {
        if (typeof item !== "string") {
          return `<a class="nav-link nav-shortcut" href="${apiPage}#${item.anchor}">${item.label}</a>`;
        }
        const out = item;
        const page = pages.find((candidate) => candidate.out === out);
        if (!page) return "";
        const active = page.out === activeOut ? " active" : "";
        const current = active ? ` aria-current="page"` : "";
        const sections = active ? renderNavSections(toc) : "";
        return `<a class="nav-link${active}" href="${page.out}"${current}>${page.nav}</a>${sections}`;
      })
      .join("\n            ");
    return `<section class="nav-group">
          <p class="nav-label">${group.label}</p>
          <div class="nav-list">
            ${items}
          </div>
        </section>`;
  }).join("\n        ");

  return `${groups}
        <a class="nav-demo" href="demo.html">Open the demo</a>
        <a class="nav-cloud" href="${SIMPLYSYNC_CLOUD_URL}">Managed Cloud ↗</a>`;
}

// Compact page navigation above the prose switches between Client API variants.
// The active page is inert text; the others are links.
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
  return `<nav class="lang-tabs" aria-label="Client language">${items}</nav>`;
}

function renderTopbar(showMenu: boolean): string {
  return `<header class="topbar">
    <div class="topbar-inner">
      ${showMenu ? MENU_TOGGLE : ""}
      <div class="brand-lockup">
        <a class="brand" href="index.html" aria-label="SimplySync home">${BRAND_MARK}<span class="brand-name">${SITE_TITLE}</span></a>
      </div>
      <nav class="topbar-links" aria-label="Primary">
        <a href="docs.html">Docs</a>
        <a href="demo.html">Demo</a>
        <a class="topbar-showcase" href="showcase.html">Showcase</a>
        <a href="${SIMPLYSYNC_CLOUD_URL}">Cloud ↗</a>
      </nav>
      ${THEME_TOGGLE}
    </div>
  </header>`;
}

function renderFooter(extraClass = ""): string {
  const className = extraClass ? `site-footer ${extraClass}` : "site-footer";
  return `<footer class="${className}">
      <div class="footer-colophon">
        <p class="footer-statement"><strong>SimplySync</strong> — app-owned, encrypted sync infrastructure.</p>
        <div class="footer-meta">
          <span>MIT licensed.</span>
          <nav class="footer-links" aria-label="Project resources">
            <a href="showcase.html">Showcase</a>
            <a href="${SIMPLYSYNC_CLOUD_URL}">Cloud ↗</a>
            <a href="${REPO_BLOB_BASE}/packages/simplysync-protocol">Source</a>
            <a href="${REPO_BLOB_BASE}/SECURITY.md">Security</a>
            <a href="llms.txt">llms.txt</a>
          </nav>
        </div>
      </div>
    </footer>`;
}

// "On this page" — a sticky rail beside the prose on wide screens, hidden
// below (the left sidebar still covers page-level navigation there). The links
// carry data-toc so the scroll-spy in SITE_SCRIPT can mark the current section
// without re-querying the DOM on every scroll.
function renderToc(toc: TocEntry[]): string {
  if (toc.length === 0) return "";
  let section = "";
  const items = toc
    .map((entry) => {
      if (entry.level === 2) section = entry.id;
      return `<li><a class="toc-link toc-l${entry.level}" data-toc data-section="${section || entry.id}" href="#${entry.id}">${entry.text}</a></li>`;
    })
    .join("\n          ");
  return `<aside class="toc-rail">
      <nav class="toc" aria-label="On this page">
        <p class="toc-title">On this page</p>
        <ul class="toc-list">
          ${items}
        </ul>
      </nav>
    </aside>`;
}

const LANDING_DIRECTORY = [
  {
    title: "Core concepts",
    entries: [
      { out: "docs.html", title: "What & why", summary: "Decide whether the single-owner model fits." },
      { out: "architecture.html", title: "How it works", summary: "Follow local writes, clocks, encryption, and blobs." },
      { out: "sync.html", title: "Sync & relay", summary: "Inspect the HTTP protocol, quotas, and compaction." },
      { out: "sync.html#threat-model", title: "Security model", summary: "See what the relay can and cannot learn." },
    ],
  },
  {
    title: "Build & operate",
    entries: [
      { out: "guide.html", title: "Client API", summary: "Define schemas, mutations, queries, and React bindings." },
      { out: "native.html", title: "Native clients", summary: "Own the Swift and Kotlin source surfaces." },
      { out: "self-hosting.html", title: "Self-hosting", summary: "Deploy the Cloudflare relay in your account." },
      { out: "agents.html", title: "For agents", summary: "Load the full invariant and implementation contract." },
    ],
  },
] as const;

// Pull the landing page's command block out of the README MARKDOWN, not the
// rendered HTML: the clone lines are wanted but the per-platform launch
// commands are not, and cutting highlighted HTML at a line boundary would slice
// through token markup. Cut the source, then highlight what's left.
function extractLandingQuickstart(markdown: string): string {
  const heading = "## Quickstart: a source-owned React Native app";
  const sectionStart = markdown.indexOf(heading);
  if (sectionStart < 0) return "";
  const fenceStart = markdown.indexOf("```sh", sectionStart);
  const fenceClose =
    fenceStart >= 0 ? markdown.indexOf("```", fenceStart + 5) : -1;
  if (fenceStart < 0 || fenceClose < 0) return "";

  let command = markdown.slice(fenceStart + "```sh\n".length, fenceClose);
  const launchStart = command.indexOf("\n\n# iOS Simulator");
  if (launchStart >= 0) command = command.slice(0, launchStart);
  command = command.trimEnd();

  return highlighter
    ? highlighter.codeToHtml(command, { lang: "sh", theme: CODE_THEME })
    : `<pre class="shiki plain"><code>${escapeHtml(command)}</code></pre>`;
}

function renderLandingDirectory(): string {
  const groups = LANDING_DIRECTORY.map((group) => {
    const entries = group.entries.map(
      (entry) => `<div class="directory-row">
          <a href="${entry.out}">${entry.title}</a>
          <span>${entry.summary}</span>
        </div>`,
    ).join("\n        ");
    return `<section class="directory-group">
        <h3>${group.title}</h3>
        ${entries}
      </section>`;
  }).join("\n      ");

  return `<nav class="landing-directory" aria-labelledby="directory-title">
    <h2 id="directory-title">Explore the docs</h2>
    <div class="directory-grid">
      ${groups}
    </div>
  </nav>`;
}

// The shared <head> block: title/description/canonical + OG/Twitter cards,
// the theme bootstrap, and the fingerprinted icon + stylesheet.
function pageHead(options: {
  title: string;
  description: string;
  canonical: string;
  assetVersion: string;
  stylesheet?: string;
}): string {
  const stylesheet = options.stylesheet ?? `styles-${options.assetVersion}.css`;
  return `<meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${options.title}</title>
  <meta name="description" content="${options.description}" />
  <link rel="canonical" href="${options.canonical}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${OG_SITE_NAME}" />
  <meta property="og:title" content="${options.title}" />
  <meta property="og:description" content="${options.description}" />
  <meta property="og:url" content="${options.canonical}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${options.title}" />
  <meta name="twitter:description" content="${options.description}" />
  ${THEME_SCRIPT}
  <link rel="icon" href="simplysync-mark-${options.assetVersion}.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="${stylesheet}" />`;
}

function landingHtml(assetVersion: string, quickstart: string): string {
  const pageTitle = `${SITE_TITLE} · App-owned local-first sync`;
  const canonical = canonicalUrl("index.html");
  return `<!doctype html>
<html lang="en">
<head>
  ${pageHead({ title: pageTitle, description: SITE_DESCRIPTION, canonical, assetVersion })}
</head>
<body class="landing-page">
  <a class="skip-link" href="#content">Skip to content</a>
  ${renderTopbar(false)}
  <main id="content" class="landing-main">
    <section class="landing-hero" aria-labelledby="landing-title">
      <header class="landing-hero-copy">
        <h1 id="landing-title">Private sync, owned by your app.</h1>
        <p>Write to local SQLite first. SimplySync seals changes on-device and sends only ciphertext through an optional relay.</p>
        <div class="landing-actions">
          <a class="landing-primary" href="guide.html">Start integrating</a>
          <a class="landing-secondary" href="demo.html">Live demo <span aria-hidden="true">→</span></a>
        </div>
      </header>
    </section>

    <figure class="landing-proof" aria-labelledby="proof-caption">
      <div class="flow-panel flow-device">
        <p class="flow-title">Device A · local SQLite</p>
        <table aria-label="Readable Todo row on device A">
          <thead><tr><th>id</th><th>title</th><th>done</th></tr></thead>
          <tbody><tr><td>42</td><td>Buy milk</td><td>0</td></tr></tbody>
        </table>
      </div>
      <span class="flow-connector" aria-hidden="true"></span>
      <div class="flow-panel flow-relay">
        <p class="flow-title">Relay · ciphertext only</p>
        <pre aria-label="Illustrative encrypted envelope"><code>{
  "eventId": "HLC",
  "nonce": "12-byte base64url",
  "ciphertext": "AES-GCM output"
}</code></pre>
      </div>
      <span class="flow-connector" aria-hidden="true"></span>
      <div class="flow-panel flow-device">
        <p class="flow-title">Device B · local SQLite</p>
        <table aria-label="Readable Todo row on device B">
          <thead><tr><th>id</th><th>title</th><th>done</th></tr></thead>
          <tbody><tr><td>42</td><td>Buy milk</td><td>0</td></tr></tbody>
        </table>
      </div>
      <figcaption id="proof-caption">Both devices keep readable SQLite. The relay receives routing metadata, a nonce, and ciphertext — never the row.</figcaption>
    </figure>

    <section class="landing-quickstart" aria-labelledby="landing-quickstart-title">
      <header class="landing-section-head">
        <div>
          <h2 id="landing-quickstart-title">Quickstart</h2>
          <p>Clone the React Native client and the source it needs.</p>
        </div>
        <a href="docs.html#quickstart-a-source-owned-react-native-app">Continue setup <span aria-hidden="true">→</span></a>
      </header>
      ${quickstart}
    </section>

    ${renderLandingDirectory()}
  </main>
  ${renderFooter("home-footer")}
  ${SITE_SCRIPT}
</body>
</html>
`;
}

const SHOWCASE_PRODUCTS = [
  {
    name: "Simply Finance",
    domain: "simplyfinance.app",
    url: SIMPLY_FINANCE_URL,
    relationship: "Powered by SimplySync",
    description:
      "A private, manual-first money app that keeps recorded transactions useful offline and offers optional end-to-end encrypted sync.",
  },
  {
    name: "Goalist",
    domain: "goalist.app",
    url: GOALIST_URL,
    relationship: "From the same maker",
    description:
      "A goal and task app organized around one primary goal, resistance lists, side quests, offline support, and optional device sync.",
  },
] as const;

function showcaseHtml(assetVersion: string): string {
  const pageTitle = `Showcase · ${SITE_TITLE}`;
  const description =
    "Simply Finance and Goalist: two local-first products from the same maker.";
  const canonical = canonicalUrl("showcase.html");
  const products = SHOWCASE_PRODUCTS.map(
    (product) => `<article class="showcase-entry">
      <header class="showcase-product">
        <h2>${product.name}</h2>
        <p>${product.domain}</p>
      </header>
      <div class="showcase-detail">
        <p>${product.description}</p>
        <div class="showcase-action">
          <span>${product.relationship}</span>
          <a href="${product.url}">Visit ${product.name} <span aria-hidden="true">↗</span></a>
        </div>
      </div>
    </article>`,
  ).join("\n    ");

  return `<!doctype html>
<html lang="en">
<head>
  ${pageHead({ title: pageTitle, description, canonical, assetVersion })}
</head>
<body class="showcase-page">
  <a class="skip-link" href="#content">Skip to content</a>
  ${renderTopbar(false)}
  <main id="content" class="showcase-main">
    <header class="showcase-intro">
      <h1>Products</h1>
      <p>Two local-first products from the same maker. Simply Finance is powered by SimplySync; Goalist is a related goal and task product.</p>
    </header>
    <section class="showcase-list" aria-label="Product showcase">
      ${products}
    </section>
  </main>
  ${renderFooter("home-footer")}
  ${SITE_SCRIPT}
</body>
</html>
`;
}

function notFoundHtml(assetVersion: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Page not found · ${SITE_TITLE}</title>
  <meta name="robots" content="noindex" />
  ${THEME_SCRIPT}
  <link rel="icon" href="simplysync-mark-${assetVersion}.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="styles-${assetVersion}.css" />
</head>
<body class="simple-page">
  <a class="skip-link" href="#content">Skip to content</a>
  ${renderTopbar(false)}
  <main id="content" class="simple-main">
    <h1>That page isn’t here.</h1>
    <p>Open the documentation or return to the SimplySync homepage.</p>
    <div class="simple-actions">
      <a href="docs.html">Read the docs</a>
      <a href="index.html">Return home</a>
    </div>
  </main>
  ${renderFooter("home-footer")}
  ${SITE_SCRIPT}
</body>
</html>
`;
}

function insertAfterFirstParagraph(content: string, addition: string): string {
  if (!addition) return content;
  const paragraphEnd = content.indexOf("</p>");
  if (paragraphEnd < 0) return `${addition}${content}`;
  const split = paragraphEnd + "</p>".length;
  return `${content.slice(0, split)}${addition}${content.slice(split)}`;
}

function renderPageNav(activeOut: string): string {
  const index = pages.findIndex((page) => page.out === activeOut);
  if (index < 0) return "";
  const previous = index > 0 ? pages[index - 1] : null;
  const next = index < pages.length - 1 ? pages[index + 1] : null;
  const previousLink = previous
    ? `<a class="page-nav-link previous" href="${previous.out}"><span class="page-nav-direction"><span aria-hidden="true">←</span> Previous</span><span class="page-nav-title">${previous.nav}</span></a>`
    : "";
  const nextLink = next
    ? `<a class="page-nav-link next" href="${next.out}"><span class="page-nav-direction">Next <span aria-hidden="true">→</span></span><span class="page-nav-title">${next.nav}</span></a>`
    : "";
  const edgeClass = previous ? (next ? "" : " only-previous") : " only-next";
  return `<nav class="page-nav${edgeClass}" aria-label="Adjacent documentation">${previousLink}${nextLink}</nav>`;
}

function layout(options: {
  title: string;
  out: string; // built filename, used for canonical metadata
  activeOut: string; // sidebar highlight
  content: string;
  toc: TocEntry[];
  assetVersion: string;
  langTabs?: readonly LangTab[];
  langActiveOut?: string; // which language tab is active
}): string {
  const pageTitle = `${options.title} · ${SITE_TITLE} Docs`;
  const canonical = canonicalUrl(options.out);
  const langBar = options.langTabs
    ? renderLangTabs(options.langTabs, options.langActiveOut ?? options.activeOut)
    : "";
  const bodyContent = langBar
    ? insertAfterFirstParagraph(
        options.content,
        `<div class="article-tools">${langBar}</div>`,
      )
    : options.content;
  return `<!doctype html>
<html lang="en">
<head>
  ${pageHead({
    title: pageTitle,
    description: SITE_DESCRIPTION,
    canonical,
    assetVersion: options.assetVersion,
  })}
</head>
<body>
  <a class="skip-link" href="#content">Skip to content</a>
  ${renderTopbar(true)}
  <div class="shell">
    <aside id="docs-sidebar" class="sidebar" aria-label="Documentation sections">
      <nav class="nav">
        ${renderNav(options.activeOut, options.out, options.toc)}
      </nav>
    </aside>
    <main id="content" class="content">
      <article class="prose">
        ${bodyContent}
        ${renderPageNav(options.activeOut)}
      </article>
    </main>
    ${renderToc(options.toc)}
    ${renderFooter()}
  </div>
  <button class="nav-scrim" type="button" aria-label="Close documentation navigation" onclick="window.ssToggleNav(false)"></button>
  ${SITE_SCRIPT}
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
  "schema.md",
  "architecture.md",
  "sync.md",
  "native.md",
  "icloud.md",
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
> ever sees ciphertext. The TypeScript, Kotlin, and Swift clients share one
> wire contract with the source-owned Cloudflare relay.

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

function demoHtml(assetVersion: string, scriptName: string): string {
  const pageTitle = `Demo · ${SITE_TITLE}`;
  const description =
    "Run the SimplySync local-first, end-to-end-encrypted engine in your browser.";
  const canonical = canonicalUrl("demo.html");
  return `<!doctype html>
<html lang="en">
<head>
  ${pageHead({
    title: pageTitle,
    description,
    canonical,
    assetVersion,
    stylesheet: `demo-${assetVersion}.css`,
  })}
</head>
<body>
  <div class="pg-topnav">
    <div class="pg-brand-lockup">
      <a class="pg-back" href="index.html" aria-label="SimplySync home">${BRAND_MARK}<span>SimplySync</span></a>
    </div>
    <div class="pg-topnav-actions">
      <a class="pg-cloud-link" href="${SIMPLYSYNC_CLOUD_URL}">Cloud ↗</a>
      ${THEME_TOGGLE}
    </div>
  </div>
  <div id="app"></div>
  <script type="module" src="${scriptName}"></script>
  ${SITE_SCRIPT}
</body>
</html>
`;
}

// Bundles the React demo SPA into dist/ with Bun's bundler (no extra toolchain),
// copies sql.js's wasm next to it, and emits the host HTML. The TodoList web app
// lives with the other clients under apps/todolist/web.
async function buildDemo(
  assetVersion: string,
  versionedDemoCss: string,
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(todoWebDir, "main.tsx")],
    outdir: distDir,
    target: "browser",
    minify: true,
    sourcemap: "none",
    naming: { entry: "demo-[hash].[ext]" },
    // React (and other libs) branch on this; browsers have no `process`.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Demo bundle failed.");
  }
  const scriptName = basename(result.outputs[0]?.path ?? "");
  if (!scriptName) throw new Error("Demo bundle emitted no entrypoint.");

  // sql.js fetches its wasm at runtime via locateFile(() => "sql-wasm.wasm").
  await copyFile(
    Bun.resolveSync("sql.js/dist/sql-wasm.wasm", here),
    join(distDir, "sql-wasm.wasm"),
  );
  await writeFile(
    join(distDir, `demo-${assetVersion}.css`),
    versionedDemoCss,
    "utf8",
  );
  // Canonical aliases keep old links useful; current HTML always references
  // fingerprinted assets so a redeploy cannot mix an old bundle with new UI.
  await copyFile(join(todoWebDir, "styles.css"), join(distDir, "demo.css"));
  await copyFile(join(distDir, scriptName), join(distDir, "demo.js"));
  await writeFile(
    join(distDir, "demo.html"),
    demoHtml(assetVersion, scriptName),
    "utf8",
  );
  console.log(
    `  apps/todolist/web → dist/${scriptName}, demo-${assetVersion}.css, demo.html (+ aliases, wasm)`,
  );
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

  const tokenCss = await readFile(join(here, "tokens.css"), "utf8");
  const docsCss = await readFile(join(here, "styles.css"), "utf8");
  const demoCss = await readFile(join(todoWebDir, "styles.css"), "utf8");
  const brandMark = await readFile(join(here, "simplysync-mark.svg"), "utf8");
  const assetVersion = createHash("sha256")
    .update(tokenCss)
    .update(docsCss)
    .update(demoCss)
    .update(brandMark)
    .digest("hex")
    .slice(0, 12);
  const versionedTokenName = `tokens-${assetVersion}.css`;
  const versionedMarkName = `simplysync-mark-${assetVersion}.svg`;
  const versionCss = (css: string): string =>
    css
      .replace('@import "tokens.css";', `@import "${versionedTokenName}";`)
      .replaceAll(
        'url("simplysync-mark.svg")',
        `url("${versionedMarkName}")`,
      );
  const versionedDocsCss = versionCss(docsCss);
  const versionedDemoCss = versionCss(demoCss);

  marked.setOptions({ gfm: true });

  // Highlight at build time. walkTokens stays synchronous because codeToHtml on
  // an already-created highlighter is sync; the renderer then just emits what it
  // produced, falling back to an escaped plain block for an unknown language.
  highlighter = await createHighlighter({
    themes: [CODE_THEME],
    langs: [...CODE_LANGS],
  });
  const loaded = new Set<string>(highlighter.getLoadedLanguages());
  marked.use({
    walkTokens(token) {
      if (token.type !== "code") return;
      const raw = (token.lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const lang = LANG_ALIASES[raw] ?? raw;
      if (!lang || !loaded.has(lang) || !highlighter) return;
      (token as { highlighted?: string }).highlighted = highlighter.codeToHtml(
        token.text,
        { lang, theme: CODE_THEME },
      );
    },
    renderer: {
      code(token) {
        const highlighted = (token as { highlighted?: string }).highlighted;
        if (highlighted) return highlighted;
        return `<pre class="shiki plain"><code>${escapeHtml(token.text)}</code></pre>`;
      },
    },
  });

  const sources = new Map<string, string>();
  let landingQuickstart = "";

  await loadDiagrams(join(docsDir, "images"));
  // Also ship the files themselves, so a direct link to one still resolves.
  if (diagrams.size > 0) {
    await mkdir(join(distDir, "images"), { recursive: true });
    for (const name of diagrams.keys()) {
      await copyFile(join(docsDir, "images", name), join(distDir, "images", name));
    }
  }

  for (const page of allPages) {
    const markdown = await readFile(join(docsDir, page.src), "utf8");
    sources.set(page.src, describeDiagrams(markdown));
    const rendered = inlineDiagrams(await marked.parse(markdown), page.src);
    const { html: withAnchors, toc } = addHeadingAnchors(rendered);
    const content = rewriteLinks(withAnchors);
    if (page.src === "README.md") {
      landingQuickstart = extractLandingQuickstart(markdown);
    }
    const html = layout({
      title: firstHeading(markdown),
      out: page.out,
      activeOut: page.navActive ?? page.out, // sidebar highlight
      langTabs: page.langTabs,
      langActiveOut: page.out, // active tab is this page
      content,
      toc,
      assetVersion,
    });
    await writeFile(join(distDir, page.out), html, "utf8");
    console.log(`  ${page.src} → dist/${page.out}`);
  }

  if (!landingQuickstart) {
    throw new Error("README.md is missing the landing-page Quickstart command.");
  }
  await writeFile(
    join(distDir, "index.html"),
    landingHtml(assetVersion, landingQuickstart),
    "utf8",
  );
  console.log("  dedicated landing page → dist/index.html");
  await writeFile(
    join(distDir, "showcase.html"),
    showcaseHtml(assetVersion),
    "utf8",
  );
  console.log("  product showcase → dist/showcase.html");

  // styles.css and demo.css both @import this shared token layer.
  await writeFile(
    join(distDir, "tokens.css"),
    tokenCss,
    "utf8",
  );
  await writeFile(join(distDir, versionedTokenName), tokenCss, "utf8");
  await writeFile(
    join(distDir, "styles.css"),
    docsCss,
    "utf8",
  );
  await writeFile(
    join(distDir, `styles-${assetVersion}.css`),
    versionedDocsCss,
    "utf8",
  );
  await writeFile(join(distDir, "simplysync-mark.svg"), brandMark, "utf8");
  await writeFile(join(distDir, versionedMarkName), brandMark, "utf8");
  // SPA-style hosts (and GitHub Pages) need a real terminal page, not a copy of
  // either the product landing page or a documentation article.
  await writeFile(
    join(distDir, "404.html"),
    notFoundHtml(assetVersion),
    "utf8",
  );

  await writeFile(join(distDir, "llms.txt"), llmsIndex(), "utf8");
  const corpus = LLMS_ORDER.map((src) => sources.get(src))
    .filter((markdown): markdown is string => Boolean(markdown))
    .join("\n\n---\n\n");
  await writeFile(join(distDir, "llms-full.txt"), corpus, "utf8");
  const sitemapEntries = [
    "index.html",
    "showcase.html",
    ...allPages.map((page) => page.out),
    "demo.html",
  ]
    .map((out) => `  <url><loc>${canonicalUrl(out)}</loc></url>`)
    .join("\n");
  await writeFile(
    join(distDir, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries}\n</urlset>\n`,
    "utf8",
  );
  await writeFile(
    join(distDir, "robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
    "utf8",
  );
  console.log("  docs/local-first/*.md → dist/llms{,-full}.txt");

  await buildDemo(assetVersion, versionedDemoCss);

  console.log(`\nBuilt landing + showcase + ${allPages.length} docs pages + demo → ${distDir}`);
}

await build();
