// Ephemeral state: presence ("who's online"), typing indicators, "the
// assistant is thinking…", live cursors. This is real-time and worthless a few
// seconds later, so it is deliberately kept OUT of the durable sync log — it is
// never persisted, never enters the outbox, and never bloats relay storage or a
// device's database. (The durable engine and this channel are independent; wire
// them to the same transport or different ones as you like.)
//
// Transport-agnostic by design. Provide any transport:
//   - `createBroadcastChannelTransport` for cross-tab presence on the web today
//     (zero infrastructure),
//   - a WebSocket you own for cross-device,
//   - a future relay push endpoint.
//
// Model: last-value-per-sender with a TTL. Each client re-publishes ("heartbeat")
// while it's present; a client that goes away — closes the tab, loses the
// network — stops publishing and simply expires from everyone's view after
// `ttlMs`. Expiry is lazy (evaluated on read against an injectable clock), so
// the core needs no timers and stays deterministically testable.

/** A pluggable message pipe. `send` broadcasts to peers; `subscribe` receives. */
export interface EphemeralTransport {
  send(message: string): void;
  subscribe(onMessage: (message: string) => void): () => void;
}

export interface PresenceChannelOptions {
  readonly transport: EphemeralTransport;
  /** Stable id for this client/device (e.g. the engine's device id). */
  readonly selfId: string;
  /** How long an entry stays "present" without a refresh. Default 15s. */
  readonly ttlMs?: number;
  /** Injectable clock for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface PresenceEntry<T> {
  readonly senderId: string;
  readonly state: T;
}

export interface PresenceChannel<T> {
  /** Broadcast (and locally record) this client's current state. Call
   * periodically (~every `ttlMs/2`) to stay present. */
  publish(state: T): void;
  /** Explicitly announce going away, dropping this client from peers' views. */
  clear(): void;
  /** Live (non-expired) entries, including this client's own. */
  list(): PresenceEntry<T>[];
  /** Subscribe to changes (a peer published / cleared). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Detach from the transport and drop all listeners. */
  stop(): void;
}

interface WireMessage {
  readonly t: string; // topic
  readonly s: string; // senderId
  readonly v?: unknown; // state (absent when gone)
  readonly gone?: true;
}

/**
 * Create a presence channel for one `topic` (e.g. "room:42:typing",
 * "presence", "thinking:msg_7"). Multiple channels can share one transport;
 * each filters to its own topic.
 */
export function createPresenceChannel<T>(
  topic: string,
  options: PresenceChannelOptions,
): PresenceChannel<T> {
  const { transport, selfId } = options;
  const ttlMs = options.ttlMs ?? 15_000;
  const now = options.now ?? (() => Date.now());

  // senderId -> { state, at } where `at` is OUR receive time, so TTL is measured
  // on the local clock (immune to a peer's clock skew).
  const entries = new Map<string, { state: T; at: number }>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const unsubscribe = transport.subscribe((raw) => {
    let msg: WireMessage;
    try {
      msg = JSON.parse(raw) as WireMessage;
    } catch {
      return; // ignore garbage on the wire
    }
    if (!msg || msg.t !== topic) return; // another topic on a shared transport
    if (msg.s === selfId) return; // our own echo — already recorded locally
    if (msg.gone) entries.delete(msg.s);
    else entries.set(msg.s, { state: msg.v as T, at: now() });
    notify();
  });

  return {
    publish(state: T) {
      entries.set(selfId, { state, at: now() });
      transport.send(JSON.stringify({ t: topic, s: selfId, v: state }));
      notify();
    },
    clear() {
      entries.delete(selfId);
      transport.send(JSON.stringify({ t: topic, s: selfId, gone: true }));
      notify();
    },
    list() {
      const cutoff = now() - ttlMs;
      const live: PresenceEntry<T>[] = [];
      for (const [senderId, entry] of entries) {
        if (entry.at >= cutoff) live.push({ senderId, state: entry.state });
      }
      return live;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      unsubscribe();
      listeners.clear();
      entries.clear();
    },
  };
}

/**
 * An in-process transport hub: every `connect()` shares one bus, so messages
 * sent by one connection reach all the others (and itself — the channel ignores
 * its own echo). Useful for tests and for multiple windows of the same process.
 */
export function createMemoryTransportHub(): { connect(): EphemeralTransport } {
  const subscribers = new Set<(message: string) => void>();
  return {
    connect(): EphemeralTransport {
      return {
        send(message) {
          for (const cb of [...subscribers]) cb(message);
        },
        subscribe(onMessage) {
          subscribers.add(onMessage);
          return () => {
            subscribers.delete(onMessage);
          };
        },
      };
    },
  };
}

/**
 * Cross-tab transport for the web via the `BroadcastChannel` API — same-origin
 * tabs/windows share presence with zero infrastructure. Throws where
 * `BroadcastChannel` is unavailable (e.g. older React Native); use a
 * network transport there.
 */
export function createBroadcastChannelTransport(
  channelName: string,
): EphemeralTransport {
  const Ctor = (globalThis as { BroadcastChannel?: typeof BroadcastChannel })
    .BroadcastChannel;
  if (typeof Ctor !== "function") {
    throw new Error("BroadcastChannel is not available in this environment.");
  }
  const bc = new Ctor(channelName);
  return {
    send(message) {
      bc.postMessage(message);
    },
    subscribe(onMessage) {
      const handler = (event: MessageEvent) =>
        onMessage(event.data as string);
      bc.addEventListener("message", handler);
      return () => bc.removeEventListener("message", handler);
    },
  };
}
