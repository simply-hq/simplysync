# TodoList web

The React/browser face of the canonical [TodoList app](../README.md). It uses
`@simplysync/react` with the browser SQLite snapshot, secure owner, and
multi-tab adapters.

Run it as a standalone local-only app:

```sh
bun run --cwd apps/todolist/web dev
```

Open <http://localhost:4200>. Enter a relay URL in the app only when you want
the two browser devices to sync beyond local IndexedDB.

This proof keeps relay transports detached between the explicit **Sync Alice**
and **Sync Bob** actions so each hop is observable. SimplySync clients normally
sync automatically and opportunistically; the manual sequence is specific to
the teaching demo.

The documentation site also bundles this directory as its interactive demo at
<http://localhost:4200/demo.html> when you run `bun run docs:dev`.

Create an independently named app from this exact client source with:

```sh
bun run scaffold web my-app
bun run --cwd apps/my-app dev
```
