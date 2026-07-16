import {
  createMemoryTransportHub,
  createPresenceChannel,
} from "@simplysync/engine";
import { aiAvailable } from "./ai";
import { sendAndReply } from "./chat";
import { createChatEngine } from "./engine";

// Demonstrates the engine's ephemeral presence channel driving an
// "AI is thinking…" indicator that OTHER devices can see — without persisting
// anything to the sync log.
//
// Two "devices" share one in-memory transport (in production this is a WebSocket
// the app provides). The assistant device publishes its status as the reply
// progresses; the viewer device observes it. The status is never written to the
// database — it's purely ephemeral, with a TTL so a crashed sender just expires.
async function main(): Promise<void> {
  const engine = createChatEngine({ dbPath: ":memory:" });
  await engine.ready;

  const hub = createMemoryTransportHub();
  const TOPIC = "assistant-status";
  const assistant = createPresenceChannel<string>(TOPIC, {
    transport: hub.connect(),
    selfId: "assistant-device",
  });
  const viewer = createPresenceChannel<string>(TOPIC, {
    transport: hub.connect(),
    selfId: "viewer-device",
  });

  // The viewer reacts to presence changes from the assistant device.
  viewer.subscribe(() => {
    const status =
      viewer.list().find((e) => e.senderId === "assistant-device")?.state ??
      "idle";
    const label =
      status === "thinking"
        ? "💭 assistant is thinking…"
        : status === "responding"
          ? "✍️  assistant is responding…"
          : "✅ assistant idle";
    console.log(`   [viewer device sees] ${label}`);
  });

  console.log(
    `AI backend: ${aiAvailable() ? "Claude (live)" : "offline stub"}\n`,
  );
  console.log("you ▸ Tell me a fun fact about octopuses.");

  const reply = await sendAndReply(engine, "Tell me a fun fact about octopuses.", {
    // Mirror the assistant's lifecycle onto the presence channel.
    onStatus: (s) => (s === "idle" ? assistant.clear() : assistant.publish(s)),
  });

  console.log(`ai  ▸ ${reply}`);

  assistant.stop();
  viewer.stop();
}

void main();
