import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const output = join(import.meta.dir, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "main.tsx")],
  outdir: output,
  target: "browser",
  minify: true,
  sourcemap: "none",
  naming: { entry: "app.[ext]" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("TodoList web bundle failed.");
}

await copyFile(
  Bun.resolveSync("sql.js/dist/sql-wasm.wasm", import.meta.dir),
  join(output, "sql-wasm.wasm"),
);
await copyFile(
  join(import.meta.dir, "../../docs/tokens.css"),
  join(output, "tokens.css"),
);
await copyFile(join(import.meta.dir, "styles.css"), join(output, "styles.css"));
await writeFile(
  join(output, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SimplySync Todo</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="app.js"></script>
</body>
</html>
`,
  "utf8",
);

console.log(`Built TodoList web app → ${output}`);
