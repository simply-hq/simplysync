// Minimal React Native interop screen. It uses @simplysync/protocol directly
// (the real library, running on Hermes via react-native-quick-crypto) to sync
// the same `todo` table as the native Swift demo, under the same recovery key.
// Point both at the same relay and rows cross over live.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stack } from "expo-router";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  compareHlc,
  createHlc,
  decryptEnvelope,
  deriveIdentity,
  encryptPayload,
  type LocalFirstIdentity,
  type SyncEnvelope,
} from "@simplysync/protocol";

// The SAME key the Swift demo / vector tests use, so this RN client is the same
// owner. Paste your own to share with a different account.
const RECOVERY_KEY = "sf1_AQgPFh0kKzI5QEdOVVxjanF4f4aNlJuiqbC3vsXM09o";
const DEFAULT_RELAY = "http://localhost:4100";
const DEVICE_ID = "expo-rn";

interface Row {
  title: string;
  done: number;
  hlc: string;
  deleted: boolean;
}

export default function InteropScreen() {
  const [identity, setIdentity] = useState<LocalFirstIdentity | null>(null);
  const [relayURL, setRelayURL] = useState(DEFAULT_RELAY);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [status, setStatus] = useState("starting");
  const [draft, setDraft] = useState("");
  const cursor = useRef("");

  useEffect(() => {
    deriveIdentity(RECOVERY_KEY)
      .then(setIdentity)
      .catch((e) => setStatus(`identity error: ${String(e?.message ?? e)}`));
  }, []);

  const applyRemote = useCallback((rowId: string, op: string, hlc: string, value: any) => {
    setRows((prev) => {
      const existing = prev[rowId];
      if (existing && compareHlc(existing.hlc, hlc) >= 0) return prev;
      return {
        ...prev,
        [rowId]: {
          title: String(value?.title ?? ""),
          done: Number(value?.done ?? 0),
          hlc,
          deleted: op === "delete",
        },
      };
    });
  }, []);

  const sync = useCallback(async () => {
    if (!identity) return;
    const base = relayURL.trim().replace(/\/$/, "");
    if (!base) {
      setStatus("offline");
      return;
    }
    const auth = { Authorization: `Bearer ${identity.relayAuth}` };
    try {
      setStatus("syncing");
      while (true) {
        const url = `${base}/v1/events?ownerId=${encodeURIComponent(identity.ownerId)}&after=${encodeURIComponent(cursor.current)}`;
        const res = await fetch(url, { headers: auth });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { events: SyncEnvelope[]; nextCursor: string };
        for (const env of body.events) {
          const payload = await decryptEnvelope<Record<string, unknown>>(identity, env);
          if (payload.table === "todo") {
            applyRemote(payload.rowId, payload.op, payload.hlc, payload.value);
          }
        }
        cursor.current = body.nextCursor;
        if (body.events.length === 0) break;
      }
      setStatus("synced");
    } catch (e) {
      setStatus(`offline (${String((e as Error).message)})`);
    }
  }, [identity, relayURL, applyRemote]);

  // Poll every 3s.
  useEffect(() => {
    if (!identity) return;
    let active = true;
    const tick = async () => {
      while (active) {
        await sync();
        await new Promise((r) => setTimeout(r, 3000));
      }
    };
    tick();
    return () => {
      active = false;
    };
  }, [identity, sync]);

  const write = useCallback(
    async (rowId: string, op: string, title: string, done: number) => {
      if (!identity) return;
      const hlc = createHlc(DEVICE_ID, Date.now(), 0);
      applyRemote(rowId, op, hlc, { title, done });
      const payload = {
        schemaVersion: 1 as const,
        table: "todo",
        op: op as "upsert" | "delete",
        rowId,
        hlc,
        value: { title, done },
      };
      const envelope = await encryptPayload(identity, { eventId: hlc, deviceId: DEVICE_ID }, payload);
      const base = relayURL.trim().replace(/\/$/, "");
      try {
        await fetch(`${base}/v1/events`, {
          method: "POST",
          headers: { Authorization: `Bearer ${identity.relayAuth}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ownerId: identity.ownerId, events: [envelope] }),
        });
      } catch {
        /* will retry on next poll via local state; minimal demo */
      }
    },
    [identity, relayURL, applyRemote],
  );

  const add = () => {
    const title = draft.trim();
    if (!title) return;
    const hlc = createHlc(DEVICE_ID, Date.now(), 0);
    write(`rn-${hlc}`, "upsert", title, 0);
    setDraft("");
  };

  // Auto-seed one row from RN (exercising on-device quick-crypto encrypt+push)
  // so the cross-sync into the Swift app is demonstrable headlessly.
  const seeded = useRef(false);
  useEffect(() => {
    if (identity && !seeded.current) {
      seeded.current = true;
      write("rn-seed", "upsert", "Made on React Native", 0);
    }
  }, [identity, write]);

  const visible = useMemo(
    () =>
      Object.entries(rows)
        .filter(([, r]) => !r.deleted)
        .sort((a, b) => (a[1].hlc < b[1].hlc ? 1 : -1)),
    [rows],
  );

  if (!identity) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator />
        <Text style={styles.muted}>{status}</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.headerRow}>
        <Text style={styles.title}>RN · Todos</Text>
        <View style={[styles.pill, status === "synced" && styles.pillOk, status.startsWith("offline") && styles.pillBad]}>
          <Text style={styles.pillText}>{status}</Text>
        </View>
      </View>
      <Text style={styles.owner}>owner {identity.ownerId.slice(0, 12)}…</Text>

      <View style={styles.row}>
        <TextInput
          style={styles.relay}
          value={relayURL}
          onChangeText={setRelayURL}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable style={styles.btnSecondary} onPress={sync}>
          <Text style={styles.btnSecondaryText}>Sync</Text>
        </Pressable>
      </View>

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Add a todo…"
          onSubmitEditing={add}
          returnKeyType="done"
        />
        <Pressable style={styles.btn} onPress={add}>
          <Text style={styles.btnText}>Add</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={{ gap: 8, paddingTop: 12 }}>
        {visible.map(([id, r]) => (
          <Pressable
            key={id}
            style={styles.todo}
            onPress={() => write(id, "upsert", r.title, r.done ? 0 : 1)}
          >
            <Text style={styles.check}>{r.done ? "☑︎" : "☐"}</Text>
            <Text style={[styles.todoText, !!r.done && styles.done]}>{r.title}</Text>
          </Pressable>
        ))}
        {visible.length === 0 ? <Text style={styles.muted}>No todos yet.</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, paddingTop: 64 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 28, fontWeight: "700" },
  owner: { color: "#888", fontSize: 12, fontFamily: "Courier", marginTop: 2 },
  pill: { backgroundColor: "#eee", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  pillOk: { backgroundColor: "#d1fae5" },
  pillBad: { backgroundColor: "#fee2e2" },
  pillText: { fontSize: 12, fontWeight: "700" },
  row: { flexDirection: "row", gap: 8, marginTop: 12 },
  relay: { flex: 1, borderWidth: 1, borderColor: "#ddd", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontFamily: "Courier", fontSize: 13 },
  input: { flex: 1, borderWidth: 1, borderColor: "#ddd", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  btn: { backgroundColor: "#6366f1", borderRadius: 8, paddingHorizontal: 18, justifyContent: "center" },
  btnText: { color: "#fff", fontWeight: "700" },
  btnSecondary: { backgroundColor: "#e5e7eb", borderRadius: 8, paddingHorizontal: 16, justifyContent: "center" },
  btnSecondaryText: { fontWeight: "600" },
  list: { flex: 1 },
  todo: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, backgroundColor: "#f3f4f6", borderRadius: 10 },
  check: { fontSize: 18 },
  todoText: { fontSize: 16, flexShrink: 1 },
  done: { color: "#9ca3af", textDecorationLine: "line-through" },
  muted: { color: "#9ca3af", textAlign: "center", marginTop: 20 },
});
