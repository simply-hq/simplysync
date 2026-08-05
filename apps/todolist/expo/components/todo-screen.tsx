import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItem,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as SecureStore from "expo-secure-store";
import {
  useQuery,
  useSyncError,
  useSyncState,
  type AppOwner,
} from "@simplysync/react-native";
import {
  DEFAULT_RELAY_URL,
  ONBOARDING_COMPLETE_KEY,
  activeTodos,
  relayTransport,
  todoEngine,
  type TodoRow,
} from "@/lib/todo-engine";

export function TodoScreen() {
  const todos = useQuery(activeTodos);
  const syncState = useSyncState();
  const syncError = useSyncError();
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [owner, setOwner] = useState<AppOwner | null>(null);
  const [ownerLoading, setOwnerLoading] = useState(true);
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(
    null,
  );
  const [relayDraft, setRelayDraft] = useState(DEFAULT_RELAY_URL);
  const [restoreDraft, setRestoreDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recoveryVisible, setRecoveryVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refreshOwner = useCallback(async () => {
    setOwner(await todoEngine.appOwner);
    setOwnerLoading(false);
  }, []);

  useEffect(() => {
    void refreshOwner().catch((error) => {
      setActionError(messageOf(error));
      setOwnerLoading(false);
    });
  }, [refreshOwner]);

  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(ONBOARDING_COMPLETE_KEY)
      .then((value) => {
        if (active) setOnboardingComplete(value === "yes");
      })
      .catch((error) => {
        if (active) {
          setActionError(messageOf(error));
          setOnboardingComplete(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const addTodo = useCallback(() => {
    const title = draft.trim();
    if (!title) return;
    const result = todoEngine.insert("todo", { title, done: 0 });
    if (!result.ok) {
      setActionError(result.error.message);
      return;
    }
    setDraft("");
    setActionError(null);
    Keyboard.dismiss();
  }, [draft]);

  const toggleTodo = useCallback((todo: TodoRow) => {
    const result = todoEngine.update("todo", {
      id: todo.id,
      done: todo.done ? 0 : 1,
    });
    if (!result.ok) setActionError(result.error.message);
  }, []);

  const deleteTodo = useCallback((todo: TodoRow) => {
    Alert.alert("Delete todo?", `"${todo.title}" will be removed on every device.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          const result = todoEngine.delete("todo", todo.id);
          if (!result.ok) setActionError(result.error.message);
        },
      },
    ]);
  }, []);

  const syncNow = useCallback(async () => {
    setRefreshing(true);
    setActionError(null);
    try {
      await todoEngine.sync();
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const saveRelay = useCallback(async () => {
    const transport = relayTransport(relayDraft);
    todoEngine.setTransports(transport ? [transport] : []);
    Keyboard.dismiss();
    if (transport) await syncNow();
  }, [relayDraft, syncNow]);

  const restoreOwner = useCallback(async () => {
    const recoveryKey = restoreDraft.trim();
    if (!recoveryKey) return;
    setActionError(null);
    try {
      await todoEngine.restoreAppOwner(recoveryKey);
      await SecureStore.setItemAsync(ONBOARDING_COMPLETE_KEY, "yes");
      setOnboardingComplete(true);
      setRestoreDraft("");
      await refreshOwner();
      await todoEngine.sync();
    } catch (error) {
      setActionError(messageOf(error));
    }
  }, [refreshOwner, restoreDraft]);

  const restoreDuringOnboarding = useCallback(async () => {
    const recoveryKey = restoreDraft.trim();
    if (!recoveryKey) return;
    setActionError(null);
    try {
      // The first-run screen prevents app writes, so replacing its temporary
      // empty owner is the narrow safe use of force. Settings restores above
      // retain the relay-backed wrong-key check.
      await todoEngine.restoreAppOwner(recoveryKey, { force: true });
      await SecureStore.setItemAsync(ONBOARDING_COMPLETE_KEY, "yes");
      setOnboardingComplete(true);
      setRestoreDraft("");
      await refreshOwner();
    } catch (error) {
      setActionError(messageOf(error));
    }
  }, [refreshOwner, restoreDraft]);

  const resetOwner = useCallback(() => {
    Alert.alert(
      "Start with a new owner?",
      "This clears this device's local todos and creates a new recovery key.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: () => {
            void SecureStore.deleteItemAsync(ONBOARDING_COMPLETE_KEY)
              .then(() => todoEngine.resetAppOwner())
              .then(async () => {
                await refreshOwner();
                setOnboardingComplete(false);
                setSettingsOpen(false);
              })
              .catch((error) => setActionError(messageOf(error)));
          },
        },
      ],
    );
  }, [refreshOwner]);

  const copyRecoveryKey = useCallback(async () => {
    if (!owner?.recoveryKey) return;
    await Clipboard.setStringAsync(owner.recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }, [owner]);

  const completeOnboarding = useCallback(async () => {
    try {
      await SecureStore.setItemAsync(ONBOARDING_COMPLETE_KEY, "yes");
      setOnboardingComplete(true);
      setActionError(null);
    } catch (error) {
      setActionError(messageOf(error));
    }
  }, []);

  const renderTodo: ListRenderItem<TodoRow> = useCallback(
    ({ item }) => (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: Boolean(item.done) }}
        onLongPress={() => deleteTodo(item)}
        onPress={() => toggleTodo(item)}
        style={({ pressed }) => [styles.todo, pressed && styles.pressed]}
      >
        <Text style={styles.check}>{item.done ? "●" : "○"}</Text>
        <Text style={[styles.todoTitle, Boolean(item.done) && styles.done]}>
          {item.title}
        </Text>
        <Pressable
          accessibilityLabel={`Delete ${item.title}`}
          hitSlop={10}
          onPress={() => deleteTodo(item)}
        >
          <Text style={styles.delete}>×</Text>
        </Pressable>
      </Pressable>
    ),
    [deleteTodo, toggleTodo],
  );

  const visibleError = actionError ?? syncError?.message ?? null;
  const status = syncLabel(syncState);

  if (ownerLoading || onboardingComplete === null) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator />
        <Text style={styles.hint}>Opening your private local database…</Text>
      </View>
    );
  }

  if (!onboardingComplete && owner) {
    return (
      <RecoverySetup
        copied={copied}
        error={visibleError}
        onConfirm={() => void completeOnboarding()}
        onCopy={() => void copyRecoveryKey()}
        onRestore={() => void restoreDuringOnboarding()}
        owner={owner}
        restoreDraft={restoreDraft}
        setRestoreDraft={setRestoreDraft}
      />
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
    >
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>SIMPLYSYNC</Text>
          <Text style={styles.title}>Todos</Text>
        </View>
        <Pressable
          accessibilityLabel="Sync settings"
          onPress={() => setSettingsOpen((current) => !current)}
          style={styles.settingsButton}
        >
          <Text style={styles.settingsButtonText}>•••</Text>
        </Pressable>
      </View>

      <View style={styles.statusRow}>
        <View style={[styles.statusDot, status.ok && styles.statusDotOk]} />
        <Text style={styles.statusText}>{status.label}</Text>
        <Text style={styles.count}>
          {todos.length} {todos.length === 1 ? "item" : "items"}
        </Text>
      </View>

      {visibleError ? (
        <Pressable onPress={() => setActionError(null)} style={styles.error}>
          <Text style={styles.errorText}>{visibleError}</Text>
        </Pressable>
      ) : null}

      {settingsOpen ? (
        <View style={styles.settings}>
          <Text style={styles.sectionLabel}>RELAY</Text>
          <View style={styles.inline}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setRelayDraft}
              placeholder="Blank for offline-only"
              style={[styles.input, styles.flex]}
              value={relayDraft}
            />
            <Pressable onPress={() => void saveRelay()} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Save</Text>
            </Pressable>
          </View>

          <Text style={styles.sectionLabel}>ADD A DEVICE</Text>
          {ownerLoading ? (
            <ActivityIndicator style={styles.ownerLoading} />
          ) : (
            <>
              <Text style={styles.ownerId}>
                {owner ? `${owner.id.slice(0, 18)}…` : "No owner"}
              </Text>
              <Text style={styles.hint}>
                On the new device, choose Restore and paste this recovery key.
              </Text>
              <Pressable
                disabled={!owner}
                onPress={() => setRecoveryVisible((current) => !current)}
              >
                <Text style={styles.link}>
                  {recoveryVisible ? "Hide add-device key" : "Show add-device key"}
                </Text>
              </Pressable>
              {recoveryVisible && owner ? (
                <>
                  <Pressable onPress={() => void copyRecoveryKey()} style={styles.secret}>
                    <Text selectable style={styles.secretText}>
                      {owner.recoveryKey}
                    </Text>
                    <Text style={styles.copy}>{copied ? "Copied" : "Tap to copy"}</Text>
                  </Pressable>
                  <Text style={styles.warning}>
                    If you lose this key, no one can recover your synced data.
                  </Text>
                </>
              ) : null}
            </>
          )}

          <Text style={styles.sectionLabel}>RESTORE ANOTHER OWNER</Text>
          <View style={styles.inline}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setRestoreDraft}
              placeholder="Paste recovery key"
              secureTextEntry
              style={[styles.input, styles.flex]}
              value={restoreDraft}
            />
            <Pressable
              disabled={!restoreDraft.trim()}
              onPress={() => void restoreOwner()}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Restore</Text>
            </Pressable>
          </View>
          <Pressable onPress={resetOwner}>
            <Text style={styles.dangerLink}>Reset local owner</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          autoFocus
          onChangeText={setDraft}
          onSubmitEditing={addTodo}
          placeholder="What needs doing?"
          returnKeyType="done"
          style={[styles.input, styles.flex]}
          value={draft}
        />
        <Pressable
          disabled={!draft.trim()}
          onPress={addTodo}
          style={({ pressed }) => [
            styles.addButton,
            !draft.trim() && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.addButtonText}>Add</Text>
        </Pressable>
      </View>

      <FlatList
        contentContainerStyle={[
          styles.list,
          todos.length === 0 && styles.emptyList,
        ]}
        data={todos as TodoRow[]}
        keyExtractor={(todo) => todo.id}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={syncNow} />
        }
        renderItem={renderTodo}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyMark}>✓</Text>
            <Text style={styles.emptyTitle}>Nothing pending</Text>
            <Text style={styles.emptyBody}>
              Add a todo here, then open the same owner in Swift, Kotlin, web,
              or CLI.
            </Text>
          </View>
        }
      />
    </KeyboardAvoidingView>
  );
}

function RecoverySetup({
  copied,
  error,
  onConfirm,
  onCopy,
  onRestore,
  owner,
  restoreDraft,
  setRestoreDraft,
}: {
  copied: boolean;
  error: string | null;
  onConfirm: () => void;
  onCopy: () => void;
  onRestore: () => void;
  owner: AppOwner;
  restoreDraft: string;
  setRestoreDraft: (value: string) => void;
}) {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.onboardingScreen}
    >
      <View style={styles.onboardingContent}>
        <Text style={styles.eyebrow}>SIMPLYSYNC</Text>
        <Text style={styles.onboardingTitle}>Save your recovery key</Text>
        <Text style={styles.onboardingBody}>
          This is the only key to your encrypted data and the shortest way to
          add another device.
        </Text>

        <Pressable onPress={onCopy} style={styles.onboardingSecret}>
          <Text selectable style={styles.secretText}>
            {owner.recoveryKey}
          </Text>
          <Text style={styles.copy}>{copied ? "Copied" : "Tap to copy"}</Text>
        </Pressable>
        <Text style={styles.warning}>
          If you lose this key, no one can recover your synced data.
        </Text>

        <Pressable onPress={onConfirm} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>I saved this key</Text>
        </Pressable>

        <View style={styles.restoreBlock}>
          <Text style={styles.sectionLabel}>ALREADY HAVE A KEY?</Text>
          <View style={styles.inline}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setRestoreDraft}
              placeholder="Paste recovery key"
              secureTextEntry
              style={[styles.input, styles.flex]}
              value={restoreDraft}
            />
            <Pressable
              disabled={!restoreDraft.trim()}
              onPress={onRestore}
              style={[styles.secondaryButton, !restoreDraft.trim() && styles.disabled]}
            >
              <Text style={styles.secondaryButtonText}>Restore</Text>
            </Pressable>
          </View>
        </View>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    </KeyboardAvoidingView>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

function syncLabel(state: ReturnType<typeof useSyncState>): {
  readonly label: string;
  readonly ok: boolean;
} {
  switch (state.type) {
    case "SyncStateIsSyncing":
      return { label: "Syncing encrypted changes…", ok: false };
    case "SyncStateIsSynced":
      return { label: "Up to date", ok: true };
    case "SyncStateIsNotSynced":
      return { label: state.error ?? "Saved locally", ok: false };
    default:
      return { label: "Saved locally", ok: false };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ink = "#18211b";
const muted = "#69756d";
const paper = "#f7f6f0";
const green = "#2d6a4f";

const styles = StyleSheet.create({
  loadingScreen: {
    alignItems: "center",
    backgroundColor: paper,
    flex: 1,
    gap: 12,
    justifyContent: "center",
    padding: 24,
  },
  onboardingScreen: {
    backgroundColor: paper,
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  onboardingContent: {
    gap: 14,
  },
  onboardingTitle: {
    color: ink,
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: -1.1,
  },
  onboardingBody: {
    color: muted,
    fontSize: 16,
    lineHeight: 23,
  },
  onboardingSecret: {
    backgroundColor: "#fff",
    borderColor: "#dadbd4",
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: green,
    borderRadius: 12,
    justifyContent: "center",
    minHeight: 50,
    paddingHorizontal: 18,
  },
  primaryButtonText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  restoreBlock: {
    borderTopColor: "#deddd4",
    borderTopWidth: 1,
    gap: 10,
    marginTop: 8,
    paddingTop: 18,
  },
  screen: {
    flex: 1,
    backgroundColor: paper,
    paddingHorizontal: 20,
    paddingTop: Platform.OS === "ios" ? 18 : 28,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  eyebrow: {
    color: green,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 2.2,
  },
  title: {
    color: ink,
    fontSize: 38,
    fontWeight: "800",
    letterSpacing: -1.4,
  },
  settingsButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: "#e9e9e1",
  },
  settingsButtonText: {
    color: ink,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 2,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 18,
    marginTop: 8,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#d29a3a",
    marginRight: 7,
  },
  statusDotOk: { backgroundColor: "#4e9b6b" },
  statusText: { color: muted, flex: 1, fontSize: 13 },
  count: { color: muted, fontSize: 13 },
  error: {
    backgroundColor: "#f8dfd9",
    borderRadius: 10,
    marginBottom: 12,
    padding: 12,
  },
  errorText: { color: "#8d3026", fontSize: 13, lineHeight: 18 },
  settings: {
    backgroundColor: "#efeee7",
    borderColor: "#deddd4",
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    marginBottom: 16,
    padding: 14,
  },
  sectionLabel: {
    color: muted,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.6,
    marginTop: 2,
  },
  inline: { flexDirection: "row", gap: 8 },
  flex: { flex: 1 },
  input: {
    backgroundColor: "#fff",
    borderColor: "#dadbd4",
    borderRadius: 12,
    borderWidth: 1,
    color: ink,
    fontSize: 16,
    minHeight: 46,
    paddingHorizontal: 13,
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: "#dfe4de",
    borderRadius: 12,
    justifyContent: "center",
    minWidth: 68,
    paddingHorizontal: 13,
  },
  secondaryButtonText: { color: ink, fontSize: 13, fontWeight: "700" },
  ownerLoading: { alignSelf: "flex-start" },
  ownerId: { color: ink, fontFamily: "Courier", fontSize: 12 },
  link: { color: green, fontSize: 13, fontWeight: "700" },
  hint: { color: muted, fontSize: 13, lineHeight: 19 },
  warning: { color: "#8d3026", fontSize: 13, lineHeight: 19 },
  dangerLink: { color: "#a34135", fontSize: 13, fontWeight: "700" },
  secret: {
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 10,
  },
  secretText: { color: ink, fontFamily: "Courier", fontSize: 11, lineHeight: 16 },
  copy: { color: green, fontSize: 11, fontWeight: "700", marginTop: 5 },
  composer: { flexDirection: "row", gap: 9, marginBottom: 14 },
  addButton: {
    alignItems: "center",
    backgroundColor: green,
    borderRadius: 12,
    justifyContent: "center",
    minWidth: 64,
    paddingHorizontal: 16,
  },
  addButtonText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.68 },
  list: {
    paddingBottom: 36,
  },
  emptyList: { flexGrow: 1 },
  todo: {
    alignItems: "center",
    backgroundColor: "#fff",
    borderColor: "#e0e1da",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    minHeight: 58,
    paddingHorizontal: 14,
  },
  check: { color: green, fontSize: 23, marginRight: 12 },
  todoTitle: { color: ink, flex: 1, fontSize: 16, lineHeight: 22 },
  done: { color: "#8f9892", textDecorationLine: "line-through" },
  delete: { color: "#a3aaa5", fontSize: 25, paddingLeft: 12 },
  separator: { height: 8 },
  empty: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 28,
    paddingBottom: 50,
  },
  emptyMark: { color: "#8db09a", fontSize: 42, fontWeight: "300" },
  emptyTitle: {
    color: ink,
    fontSize: 20,
    fontWeight: "700",
    marginTop: 8,
  },
  emptyBody: {
    color: muted,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 6,
    textAlign: "center",
  },
});
