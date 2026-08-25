import { describe, expect, test } from "bun:test";

import {
  createMemoryTransportHub,
  createPresenceChannel,
} from "../src/index";

// A controllable clock so TTL expiry is deterministic (no real timers).
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const names = (entries: { senderId: string; state: { name: string } }[]) =>
  entries
    .map((e) => e.state.name)
    .sort()
    .join(",");

describe("presence channel", () => {
  test("peers see each other's published state, ignoring their own echo", () => {
    const hub = createMemoryTransportHub();
    const c = clock();
    const a = createPresenceChannel<{ name: string }>("presence", {
      transport: hub.connect(),
      selfId: "A",
      now: c.now,
    });
    const b = createPresenceChannel<{ name: string }>("presence", {
      transport: hub.connect(),
      selfId: "B",
      now: c.now,
    });

    a.publish({ name: "alice" });
    b.publish({ name: "bob" });

    // Each sees both (own state recorded locally, peer's via transport).
    expect(names(a.list())).toBe("alice,bob");
    expect(names(b.list())).toBe("alice,bob");
    a.stop();
    b.stop();
  });

  test("entries expire after the TTL without a refresh", () => {
    const hub = createMemoryTransportHub();
    const c = clock();
    const a = createPresenceChannel<{ name: string }>("presence", {
      transport: hub.connect(),
      selfId: "A",
      ttlMs: 10_000,
      now: c.now,
    });
    const b = createPresenceChannel<{ name: string }>("presence", {
      transport: hub.connect(),
      selfId: "B",
      ttlMs: 10_000,
      now: c.now,
    });

    a.publish({ name: "alice" });
    b.publish({ name: "bob" });
    expect(names(b.list())).toBe("alice,bob");

    // 11s later, alice hasn't re-published -> she expires from B's view; bob
    // heartbeats and stays.
    c.advance(11_000);
    b.publish({ name: "bob" });
    expect(names(b.list())).toBe("bob");
    a.stop();
    b.stop();
  });

  test("clear() drops a client immediately", () => {
    const hub = createMemoryTransportHub();
    const c = clock();
    const a = createPresenceChannel<{ name: string }>("presence", {
      transport: hub.connect(),
      selfId: "A",
      now: c.now,
    });
    const b = createPresenceChannel<{ name: string }>("presence", {
      transport: hub.connect(),
      selfId: "B",
      now: c.now,
    });
    a.publish({ name: "alice" });
    b.publish({ name: "bob" });
    a.clear();
    expect(names(b.list())).toBe("bob");
    a.stop();
    b.stop();
  });

  test("notifies subscribers on a peer update and topics stay isolated", () => {
    const hub = createMemoryTransportHub();
    const c = clock();
    const typing = createPresenceChannel<boolean>("room:1:typing", {
      transport: hub.connect(),
      selfId: "A",
      now: c.now,
    });
    const thinking = createPresenceChannel<boolean>("thinking:msg_7", {
      transport: hub.connect(),
      selfId: "A",
      now: c.now,
    });
    const peerTyping = createPresenceChannel<boolean>("room:1:typing", {
      transport: hub.connect(),
      selfId: "B",
      now: c.now,
    });

    let typingNotifs = 0;
    typing.subscribe(() => (typingNotifs += 1));
    let thinkingNotifs = 0;
    thinking.subscribe(() => (thinkingNotifs += 1));

    peerTyping.publish(true);
    // The typing channel heard B; the (different-topic) thinking channel did not.
    expect(typingNotifs).toBe(1);
    expect(thinkingNotifs).toBe(0);
    expect(typing.list().map((e) => e.senderId)).toEqual(["B"]);

    typing.stop();
    thinking.stop();
    peerTyping.stop();
  });

  test("an AI 'thinking' indicator is ephemeral and clears when done", () => {
    const hub = createMemoryTransportHub();
    const c = clock();
    const ui = createPresenceChannel<boolean>("thinking:msg_7", {
      transport: hub.connect(),
      selfId: "viewer",
      now: c.now,
    });
    const worker = createPresenceChannel<boolean>("thinking:msg_7", {
      transport: hub.connect(),
      selfId: "assistant",
      now: c.now,
    });

    worker.publish(true); // assistant starts generating
    expect(ui.list().some((e) => e.senderId === "assistant" && e.state)).toBe(
      true,
    );
    worker.clear(); // generation finished
    expect(ui.list().some((e) => e.senderId === "assistant")).toBe(false);

    ui.stop();
    worker.stop();
  });
});

describe("presence channel (hostile input)", () => {
  test("garbage and foreign messages on a shared transport are ignored", () => {
    // One transport commonly carries several channels, and on the web that
    // transport is a BroadcastChannel any script on the origin can post to.
    // Presence is a read surface for the UI: a message it can't parse must be
    // dropped, never thrown from inside a subscriber callback.
    const hub = createMemoryTransportHub();
    const c = clock();
    const mine = hub.connect();
    const theirs = hub.connect();
    const channel = createPresenceChannel<{ name: string }>("presence", {
      transport: mine,
      selfId: "me",
      now: c.now,
    });

    channel.publish({ name: "me" });
    expect(names(channel.list())).toBe("me");

    theirs.send("not json at all");
    theirs.send("null");
    theirs.send(JSON.stringify({ t: "typing", s: "peer", v: { name: "wrong-topic" } }));
    theirs.send(JSON.stringify({ t: "presence", s: "me", v: { name: "spoofed" } }));

    // Unparseable, another topic, and an impersonation of this client's own id
    // all leave the view untouched.
    expect(names(channel.list())).toBe("me");

    // A well-formed peer on the right topic still lands.
    theirs.send(JSON.stringify({ t: "presence", s: "peer", v: { name: "peer" } }));
    expect(names(channel.list())).toBe("me,peer");

    channel.stop();
  });
});
