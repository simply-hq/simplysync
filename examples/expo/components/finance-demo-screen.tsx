import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  type ListRenderItem,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import * as Clipboard from "expo-clipboard";

import { type FinanceEntry } from "@/lib/local-first-client";
import { useLocalFirstDemo } from "@/lib/local-first-provider";

export function FinanceDemoScreen() {
  const {
    balanceCents,
    entries,
    entryCount,
    envelopeSample,
    error,
    hasMoreEntries,
    isBooting,
    isLoadingMoreEntries,
    isSyncing,
    localDeviceId,
    ownerId,
    recoveryKey,
    relayUrl,
    syncSummary,
    addEntry,
    deleteEntry,
    dismissError,
    loadMoreEntries,
    resetDemo,
    restoreFromRecoveryKey,
    saveRelayUrl,
    seedSample,
    syncNow,
  } = useLocalFirstDemo();
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [entryKind, setEntryKind] = useState<"expense" | "income">("expense");
  const [relayDraft, setRelayDraft] = useState(relayUrl);
  const [relaySaved, setRelaySaved] = useState(false);
  const [restoreKey, setRestoreKey] = useState("");
  const [showRecoveryKey, setShowRecoveryKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const canSubmit =
    description.trim().length > 0 && parseAmountToCents(amount) !== null;
  const canRestore = restoreKey.trim().length > 0 && !isSyncing;

  useEffect(() => {
    setRelayDraft(relayUrl);
  }, [relayUrl]);

  async function handleAddEntry() {
    const amountCents = parseAmountToCents(amount);
    if (!description.trim() || amountCents === null) return;

    // The sign comes from the Expense/Income toggle: iOS's decimal pad has no
    // minus key, so a typed sign can't be the only way to record an expense.
    const signedCents =
      entryKind === "expense" ? -Math.abs(amountCents) : Math.abs(amountCents);

    try {
      await addEntry(description.trim(), signedCents);
      setDescription("");
      setAmount("");
    } catch {
      // Keep the drafts so the user can retry; the error banner explains why.
    }
  }

  async function handleSaveRelayUrl() {
    Keyboard.dismiss();
    try {
      await saveRelayUrl(relayDraft);
      setRelaySaved(true);
      setTimeout(() => setRelaySaved(false), 1400);
    } catch {
      // Surfaced via the error banner.
    }
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      await syncNow();
    } catch {
      // Surfaced via the error banner.
    } finally {
      setIsRefreshing(false);
    }
  }

  async function handleCopyRecoveryKey() {
    if (!recoveryKey) return;
    await Clipboard.setStringAsync(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  const handleDeleteEntry = useCallback(
    (entry: FinanceEntry) => {
      Alert.alert(
        "Delete entry?",
        `"${entry.description}" (${formatCents(entry.amountCents)}) will be removed from every synced device.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => {
              void deleteEntry(entry.id).catch(() => undefined);
            },
          },
        ],
      );
    },
    [deleteEntry],
  );

  function handleReset() {
    Alert.alert(
      "Reset demo?",
      "This clears local entries and creates a new recovery key for this app install.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: () => {
            void resetDemo();
          },
        },
      ],
    );
  }

  function handleRestore() {
    const nextRecoveryKey = restoreKey.trim();
    if (!nextRecoveryKey) return;

    Alert.alert(
      "Restore owner?",
      "This replaces the current local owner and pulls that owner's encrypted relay history.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restore",
          onPress: () => {
            void restoreFromRecoveryKey(nextRecoveryKey)
              .then(() => setRestoreKey(""))
              .catch(() => undefined);
          },
        },
      ],
    );
  }

  const renderEntry = useCallback<ListRenderItem<FinanceEntry>>(
    ({ item }) => (
      <View style={styles.entryCard}>
        <View style={styles.entryText}>
          <Text numberOfLines={1} style={styles.entryTitle}>
            {item.description}
          </Text>
          <Text numberOfLines={1} style={styles.entryMeta}>
            {item.updatedAtHlc}
          </Text>
        </View>
        <Text
          style={[
            styles.entryAmount,
            item.amountCents < 0 ? styles.negative : styles.positive,
          ]}
        >
          {formatCents(item.amountCents)}
        </Text>
        <Pressable
          accessibilityLabel={`Delete ${item.description}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => handleDeleteEntry(item)}
          style={({ pressed }) => [
            styles.deleteButton,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={styles.deleteButtonText}>Delete</Text>
        </Pressable>
      </View>
    ),
    [handleDeleteEntry],
  );

  if (isBooting) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.select({ ios: "padding", default: undefined })}
      style={styles.keyboard}
    >
      <FlatList
        ListEmptyComponent={
          <View style={styles.surface}>
            <Text style={styles.emptyText}>No local entries yet.</Text>
          </View>
        }
        ListFooterComponent={
          hasMoreEntries ? (
            <Pressable
              accessibilityRole="button"
              disabled={isLoadingMoreEntries}
              onPress={() => {
                void loadMoreEntries();
              }}
              style={({ pressed }) => [
                styles.loadMoreButton,
                isLoadingMoreEntries && styles.buttonDisabled,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.secondaryButtonText}>
                {isLoadingMoreEntries ? "Loading" : "Load More"}
              </Text>
            </Pressable>
          ) : null
        }
        ListHeaderComponent={
          <>
            <View style={styles.header}>
              <View>
                <Text style={styles.eyebrow}>Secure local-first sync</Text>
                <Text style={styles.title}>Finance Ledger</Text>
              </View>
              <View style={styles.balanceBox}>
                <Text style={styles.balanceLabel}>Balance</Text>
                <Text
                  style={[
                    styles.balanceValue,
                    balanceCents < 0 ? styles.negative : styles.positive,
                  ]}
                >
                  {formatCents(balanceCents)}
                </Text>
              </View>
            </View>

            {error ? (
              <View style={styles.errorBanner}>
                <Text selectable style={styles.errorText}>
                  {error}
                </Text>
                <Pressable
                  accessibilityLabel="Dismiss error"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={dismissError}
                  style={({ pressed }) => [pressed && styles.buttonPressed]}
                >
                  <Text style={styles.errorDismiss}>✕</Text>
                </Pressable>
              </View>
            ) : null}

            <View style={styles.surface}>
              <Text style={styles.sectionTitle}>Relay</Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onChangeText={setRelayDraft}
                placeholder="http://localhost:4100"
                style={styles.input}
                value={relayDraft}
              />
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    void handleSaveRelayUrl();
                  }}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>
                    {relaySaved ? "Saved" : "Save URL"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={isSyncing}
                  onPress={() => {
                    void syncNow().catch(() => undefined);
                  }}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    isSyncing && styles.buttonDisabled,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.primaryButtonText}>
                    {isSyncing ? "Syncing" : "Sync Now"}
                  </Text>
                </Pressable>
              </View>
              <Text style={styles.caption}>
                {syncSummary
                  ? `Pushed ${syncSummary.pushed}, pulled ${syncSummary.pulled}, applied ${syncSummary.applied}`
                  : `Owner ${shortId(ownerId)} / Device ${shortId(localDeviceId)}`}
              </Text>
            </View>

            <View style={styles.surface}>
              <Text style={styles.sectionTitle}>New Entry</Text>
              <TextInput
                onChangeText={setDescription}
                placeholder="Description"
                style={styles.input}
                value={description}
              />
              <View style={styles.segmentRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: entryKind === "expense" }}
                  onPress={() => setEntryKind("expense")}
                  style={[
                    styles.segment,
                    entryKind === "expense" && styles.segmentActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      entryKind === "expense" && styles.segmentTextActive,
                    ]}
                  >
                    Expense
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: entryKind === "income" }}
                  onPress={() => setEntryKind("income")}
                  style={[
                    styles.segment,
                    entryKind === "income" && styles.segmentActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      entryKind === "income" && styles.segmentTextActive,
                    ]}
                  >
                    Income
                  </Text>
                </Pressable>
              </View>
              <TextInput
                keyboardType="decimal-pad"
                onChangeText={setAmount}
                placeholder="12.34"
                style={styles.input}
                value={amount}
              />
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    void seedSample().catch(() => undefined);
                  }}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>Seed Sample</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={!canSubmit}
                  onPress={() => {
                    void handleAddEntry();
                  }}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    !canSubmit && styles.buttonDisabled,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.primaryButtonText}>Add Entry</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.surface}>
              <Text style={styles.sectionTitle}>Private Sync</Text>
              <View style={styles.keyRow}>
                <Text numberOfLines={1} selectable style={styles.keyText}>
                  {showRecoveryKey ? recoveryKey : maskSecret(recoveryKey)}
                </Text>
                <Pressable
                  accessibilityLabel={
                    showRecoveryKey ? "Hide recovery key" : "Reveal recovery key"
                  }
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => setShowRecoveryKey((visible) => !visible)}
                  style={({ pressed }) => [
                    styles.smallButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.smallButtonText}>
                    {showRecoveryKey ? "Hide" : "Reveal"}
                  </Text>
                </Pressable>
              </View>
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityLabel="Copy recovery key"
                  accessibilityRole="button"
                  onPress={() => {
                    void handleCopyRecoveryKey();
                  }}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>
                    {copied ? "Copied" : "Copy Key"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={handleReset}
                  style={({ pressed }) => [
                    styles.destructiveButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.destructiveButtonText}>Reset</Text>
                </Pressable>
              </View>
              <View style={styles.restoreBox}>
                <Text style={styles.subsectionTitle}>Restore</Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setRestoreKey}
                  placeholder="Paste recovery key"
                  style={styles.input}
                  value={restoreKey}
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={!canRestore}
                  onPress={handleRestore}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    !canRestore && styles.buttonDisabled,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.primaryButtonText}>
                    {isSyncing ? "Syncing" : "Restore & Sync"}
                  </Text>
                </Pressable>
              </View>
              <Text selectable style={styles.ciphertext}>
                {envelopeSample
                  ? truncate(envelopeSample, 260)
                  : "Ciphertext appears here after the first local write."}
              </Text>
            </View>

            <View style={styles.entriesHeader}>
              <Text style={styles.sectionTitle}>Entries</Text>
              <Text style={styles.counter}>{formatCount(entryCount)}</Text>
            </View>
          </>
        }
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        data={entries}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(entry) => entry.id}
        onEndReached={
          hasMoreEntries
            ? () => {
                void loadMoreEntries();
              }
            : undefined
        }
        onEndReachedThreshold={0.6}
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              void handleRefresh();
            }}
            refreshing={isRefreshing}
          />
        }
        renderItem={renderEntry}
      />
    </KeyboardAvoidingView>
  );
}

function parseAmountToCents(value: string): number | null {
  const normalized = value.replace(/[$,]/g, "").trim();
  if (!normalized) return null;

  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;

  return Math.round(amount * 100);
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function shortId(value: string | null): string {
  return value ? value.slice(0, 10) : "pending";
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function maskSecret(value: string | null): string {
  if (!value) return "pending";
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

const styles = StyleSheet.create({
  actionRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
    marginTop: 12,
  },
  balanceBox: {
    alignItems: "flex-end",
    flexShrink: 0,
    gap: 4,
  },
  balanceLabel: {
    color: "#687076",
    fontSize: 12,
    fontWeight: "600",
  },
  balanceValue: {
    fontSize: 28,
    fontWeight: "800",
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonPressed: {
    opacity: 0.72,
  },
  caption: {
    color: "#687076",
    fontSize: 12,
    marginTop: 12,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  ciphertext: {
    backgroundColor: "#101418",
    borderRadius: 8,
    color: "#d7dee5",
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: 11,
    lineHeight: 16,
    marginTop: 14,
    padding: 12,
  },
  content: {
    gap: 14,
    padding: 18,
    paddingBottom: 36,
  },
  counter: {
    backgroundColor: "#eaf0f4",
    borderRadius: 10,
    color: "#34404a",
    fontSize: 12,
    fontWeight: "700",
    minWidth: 28,
    overflow: "hidden",
    paddingHorizontal: 9,
    paddingVertical: 3,
    textAlign: "center",
  },
  deleteButton: {
    borderColor: "#f0c8c8",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  deleteButtonText: {
    color: "#b62828",
    fontSize: 12,
    fontWeight: "700",
  },
  destructiveButton: {
    alignItems: "center",
    backgroundColor: "#ffe9e9",
    borderRadius: 8,
    flex: 1,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  destructiveButtonText: {
    color: "#a72222",
    fontSize: 14,
    fontWeight: "800",
  },
  emptyText: {
    color: "#687076",
    fontSize: 14,
    paddingVertical: 12,
  },
  entriesHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 2,
    paddingTop: 4,
  },
  entryAmount: {
    fontSize: 15,
    fontWeight: "800",
    minWidth: 84,
    textAlign: "right",
  },
  entryCard: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e2e8ec",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    minHeight: 64,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  entryMeta: {
    color: "#7a858e",
    fontSize: 11,
    marginTop: 3,
  },
  entryRow: {
    alignItems: "center",
    borderTopColor: "#edf1f3",
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 10,
    minHeight: 64,
    paddingVertical: 10,
  },
  entryText: {
    flex: 1,
    minWidth: 0,
  },
  entryTitle: {
    color: "#182027",
    fontSize: 16,
    fontWeight: "700",
  },
  errorBanner: {
    alignItems: "flex-start",
    backgroundColor: "#fff2cc",
    borderColor: "#f0d885",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    padding: 12,
  },
  errorDismiss: {
    color: "#715900",
    fontSize: 14,
    fontWeight: "700",
  },
  errorText: {
    color: "#715900",
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  eyebrow: {
    color: "#657079",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  header: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 16,
    justifyContent: "space-between",
  },
  input: {
    backgroundColor: "#f5f7f8",
    borderColor: "#d8e0e5",
    borderRadius: 8,
    borderWidth: 1,
    color: "#182027",
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  keyboard: {
    backgroundColor: "#fbfcfd",
    flex: 1,
  },
  keyRow: {
    alignItems: "center",
    backgroundColor: "#f5f7f8",
    borderColor: "#d8e0e5",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginTop: 6,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  keyText: {
    color: "#29333b",
    flex: 1,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: 12,
  },
  loadMoreButton: {
    alignItems: "center",
    backgroundColor: "#e8edf1",
    borderRadius: 8,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  negative: {
    color: "#b62828",
  },
  positive: {
    color: "#16724a",
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#15202b",
    borderRadius: 8,
    flex: 1,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800",
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: "#e8edf1",
    borderRadius: 8,
    flex: 1,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  secondaryButtonText: {
    color: "#26323c",
    fontSize: 14,
    fontWeight: "800",
  },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  segment: {
    alignItems: "center",
    borderRadius: 6,
    flex: 1,
    justifyContent: "center",
    minHeight: 36,
  },
  segmentActive: {
    backgroundColor: "#ffffff",
    borderColor: "#d8e0e5",
    borderWidth: 1,
  },
  segmentRow: {
    backgroundColor: "#eef2f5",
    borderRadius: 8,
    flexDirection: "row",
    gap: 4,
    padding: 3,
  },
  segmentText: {
    color: "#687076",
    fontSize: 13,
    fontWeight: "700",
  },
  segmentTextActive: {
    color: "#182027",
  },
  sectionTitle: {
    color: "#182027",
    fontSize: 17,
    fontWeight: "800",
    marginBottom: 10,
  },
  restoreBox: {
    borderTopColor: "#edf1f3",
    borderTopWidth: 1,
    gap: 10,
    marginTop: 4,
    paddingTop: 14,
  },
  smallButton: {
    alignItems: "center",
    backgroundColor: "#e8edf1",
    borderRadius: 8,
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  smallButtonText: {
    color: "#26323c",
    fontSize: 12,
    fontWeight: "800",
  },
  subsectionTitle: {
    color: "#34404a",
    fontSize: 14,
    fontWeight: "800",
  },
  surface: {
    backgroundColor: "#ffffff",
    borderColor: "#e2e8ec",
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  title: {
    color: "#182027",
    fontSize: 32,
    fontWeight: "900",
    letterSpacing: 0,
  },
});
