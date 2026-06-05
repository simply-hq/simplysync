import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  type ListRenderItem,
  Platform,
  Pressable,
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
    loadMoreEntries,
    resetDemo,
    restoreFromRecoveryKey,
    saveRelayUrl,
    seedSample,
    syncNow,
  } = useLocalFirstDemo();
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [relayDraft, setRelayDraft] = useState(relayUrl);
  const [restoreKey, setRestoreKey] = useState("");
  const [showRecoveryKey, setShowRecoveryKey] = useState(false);
  const [copied, setCopied] = useState(false);

  const canSubmit =
    description.trim().length > 0 && parseAmountToCents(amount) !== null;
  const canRestore = restoreKey.trim().length > 0 && !isSyncing;

  useEffect(() => {
    setRelayDraft(relayUrl);
  }, [relayUrl]);

  async function handleAddEntry() {
    const amountCents = parseAmountToCents(amount);
    if (!description.trim() || amountCents === null) return;

    await addEntry(description.trim(), amountCents);
    setDescription("");
    setAmount("");
  }

  async function handleCopyRecoveryKey() {
    if (!recoveryKey) return;
    await Clipboard.setStringAsync(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

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
          onPress={() => {
            void deleteEntry(item.id);
          }}
          style={({ pressed }) => [
            styles.deleteButton,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={styles.deleteButtonText}>Delete</Text>
        </Pressable>
      </View>
    ),
    [deleteEntry],
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

            {error ? <Text selectable style={styles.errorText}>{error}</Text> : null}

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
                  onPress={() => {
                    void saveRelayUrl(relayDraft);
                  }}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>Save URL</Text>
                </Pressable>
                <Pressable
                  disabled={isSyncing}
                  onPress={() => {
                    void syncNow();
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
              <TextInput
                keyboardType="decimal-pad"
                onChangeText={setAmount}
                placeholder="-12.34"
                style={styles.input}
                value={amount}
              />
              <View style={styles.actionRow}>
                <Pressable
                  onPress={() => {
                    void seedSample();
                  }}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>Seed Sample</Text>
                </Pressable>
                <Pressable
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
  errorText: {
    backgroundColor: "#fff2cc",
    borderColor: "#f0d885",
    borderRadius: 8,
    borderWidth: 1,
    color: "#715900",
    fontSize: 13,
    lineHeight: 18,
    padding: 12,
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
