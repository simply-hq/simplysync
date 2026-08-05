import { join, normalize } from "node:path";

const root = join(import.meta.dir, "dist");
const port = Number(process.env.PORT ?? 4200);

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const path = normalize(join(root, requested));
    if (!path.startsWith(`${root}/`) && path !== root) {
      return new Response("Not found", { status: 404 });
    }
    const file = Bun.file(path);
    return (await file.exists())
      ? new Response(file)
      : new Response(Bun.file(join(root, "index.html")), { status: 404 });
  },
});

console.log(`TodoList web app on http://localhost:${port}`);
