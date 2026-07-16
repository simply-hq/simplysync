# @simplysync/ai-chat

A fast, **local-first AI chat** example built on [`@simplysync/engine`](../../packages/simplysync-engine/README.md) and the Claude Messages API. Messages are written to a local SQLite database first and render instantly; the assistant reply streams in token-by-token; sync (if a relay is configured) happens in the background.

## Why it's fast

It leans on the engine's streaming-write primitive. An assistant reply is streamed into the local row with `{ local: true }` on every token — the UI updates immediately, but those intermediate writes are **not** pushed to the relay. One normal write at the end commits the finished message, so a 500-token reply replicates as **a single event**, not 500. See `src/chat.ts`.

Other engine features it uses: fractional-index message ordering (`keyBetween`), structured `content` via `JsonText`, and conflict-free `reaction` counters.

## Run it

```sh
# From the repo root (installs the Anthropic SDK + workspace deps)
bun install

# Non-interactive two-turn demo (runs offline with a stub if no API key)
bun run --cwd examples/ai-chat demo

# Presence demo: one "device" sees another's "AI is thinking…" status live
bun run --cwd examples/ai-chat presence-demo

# Reactions demo: conflict-free like counts (rapid taps never lost)
bun run --cwd examples/ai-chat reactions-demo

# Content demo: structured message blocks (attachments, model metadata) as JSON
bun run --cwd examples/ai-chat content-demo

# Relay sync demo: two "devices" on one recovery phrase converge (in-process relay)
bun run --cwd examples/ai-chat relay-demo

# Search demo: case-insensitive, multi-term transcript search
bun run --cwd examples/ai-chat search-demo

# Interactive chat (history persists to ./data/ai-chat.db)
bun run --cwd examples/ai-chat chat
```

### Real Claude replies

Set an API key and the chat streams from Claude (default model `claude-opus-4-8`):

```sh
export ANTHROPIC_API_KEY=sk-ant-...
bun run --cwd examples/ai-chat chat
# Override the model:    CLAUDE_MODEL=claude-haiku-4-5 bun run ... chat
# Fast Mode (Opus 4.8, ~2.5x output tokens/sec, beta + premium pricing):
#                        FAST=1 bun run ... chat
```

Without a key it falls back to a streamed offline stub, so the example always runs and the engine pattern is fully exercised.

### Sync across devices

```sh
RELAY_URL=http://localhost:4100 bun run --cwd examples/ai-chat chat
```

Point two instances (sharing one recovery phrase) at the same relay and the transcript converges.

## Files

| File | What it does |
| --- | --- |
| `src/engine.ts` | Bun SQLite driver + secure storage, the chat schema, and query helpers |
| `src/ai.ts` | Streams an assistant reply from Claude (or an offline stub) |
| `src/chat.ts` | The local-first send→stream→commit pattern (the core of the example); emits `thinking`/`responding`/`idle` status |
| `src/demo.ts` | Non-interactive two-turn run (verifiable offline) |
| `src/presence-demo.ts` | Ephemeral "AI is thinking…" presence across two devices (never persisted) |
| `src/reactions.ts` | Conflict-free message reactions (👍/❤️/…) via the counter |
| `src/reactions-demo.ts` | Reactions demo — rapid likes all counted, no lost increments |
| `src/content.ts` | Typed content blocks (text / attachment / tool_use / model) ↔ JSON |
| `src/content-demo.ts` | Structured content round-trip (attachments + model metadata) |
| `src/relay-demo.ts` | Two devices (one recovery phrase) converging through an in-process relay |
| `src/search-demo.ts` | Case-insensitive, multi-term transcript search |
| `src/index.ts` | Interactive terminal chat (`/search`, `/react <emoji>`, local "thinking…" indicator) |
