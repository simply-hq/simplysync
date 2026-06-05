import { join } from "node:path";

// Tiny static server for previewing dist/ locally: `bun run dev`.
const distDir = join(import.meta.dir, "dist");
const port = Number(process.env.PORT ?? 4200);

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!pathname.includes(".")) pathname += ".html";

    const file = Bun.file(join(distDir, pathname));
    if (await file.exists()) return new Response(file);

    return new Response(Bun.file(join(distDir, "404.html")), { status: 404 });
  },
});

console.log(`Docs preview on http://localhost:${port}`);
