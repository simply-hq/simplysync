import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { Platform } from "react-native";

import * as SecureStore from "expo-secure-store";

import {
  ExpoLocalFirstClient,
  type EntryPageCursor,
  type FinanceEntry,
  type SyncSummary,
} from "@/lib/local-first-client";

interface LocalFirstDemoContextValue {
  readonly balanceCents: number;
  readonly entries: FinanceEntry[];
  readonly entryCount: number;
  readonly envelopeSample: string | null;
  readonly error: string | null;
  readonly hasMoreEntries: boolean;
  readonly isBooting: boolean;
  readonly isLoadingMoreEntries: boolean;
  readonly isSyncing: boolean;
  readonly localDeviceId: string | null;
  readonly ownerId: string | null;
  readonly recoveryKey: string | null;
  readonly relayUrl: string;
  readonly syncSummary: SyncSummary | null;
  readonly addEntry: (description: string, amountCents: number) => Promise<void>;
  readonly deleteEntry: (id: string) => Promise<void>;
  readonly loadMoreEntries: () => Promise<void>;
  readonly resetDemo: () => Promise<void>;
  readonly restoreFromRecoveryKey: (recoveryKey: string) => Promise<void>;
  readonly saveRelayUrl: (relayUrl: string) => Promise<void>;
  readonly seedSample: () => Promise<void>;
  readonly syncNow: () => Promise<void>;
}

const RELAY_URL_STORAGE_KEY = "simplysync.localFirstDemo.relayUrl";
const LocalFirstDemoContext = createContext<LocalFirstDemoContextValue | null>(
  null,
);

export function LocalFirstDemoProvider({ children }: PropsWithChildren) {
  const [balanceCents, setBalanceCents] = useState(0);
  const [client, setClient] = useState<ExpoLocalFirstClient | null>(null);
  const [entries, setEntries] = useState<FinanceEntry[]>([]);
  const [entryCount, setEntryCount] = useState(0);
  const [entryCursor, setEntryCursor] = useState<EntryPageCursor | null>(null);
  const [envelopeSample, setEnvelopeSample] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMoreEntries, setHasMoreEntries] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  const [isLoadingMoreEntries, setIsLoadingMoreEntries] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [relayUrl, setRelayUrl] = useState(getDefaultRelayUrl());
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);

  const publishClientState = useCallback(
    async (targetClient: ExpoLocalFirstClient) => {
      const [entryPage, nextBalanceCents, nextEntryCount, nextEnvelopeSample] =
        await Promise.all([
          targetClient.getEntryPage(),
          targetClient.getBalanceCents(),
          targetClient.getEntryCount(),
          targetClient.getStoredEnvelopeJson(),
        ]);

      setBalanceCents(nextBalanceCents);
      setEntries(entryPage.entries);
      setEntryCount(nextEntryCount);
      setEntryCursor(entryPage.nextCursor);
      setHasMoreEntries(entryPage.hasMore);
      setEnvelopeSample(nextEnvelopeSample);
      setLocalDeviceId(targetClient.localDeviceId);
      setOwnerId(targetClient.ownerId);
      setRecoveryKey(targetClient.recoveryKey);
      setRelayUrl(targetClient.currentRelayUrl);
    },
    [],
  );

  const loadMoreEntries = useCallback(async () => {
    if (!client || !entryCursor || !hasMoreEntries || isLoadingMoreEntries) {
      return;
    }

    setIsLoadingMoreEntries(true);
    try {
      const entryPage = await client.getEntryPage({ cursor: entryCursor });
      setEntries((currentEntries) => [
        ...currentEntries,
        ...entryPage.entries,
      ]);
      setEntryCursor(entryPage.nextCursor);
      setHasMoreEntries(entryPage.hasMore);
    } finally {
      setIsLoadingMoreEntries(false);
    }
  }, [client, entryCursor, hasMoreEntries, isLoadingMoreEntries]);

  useEffect(() => {
    let active = true;
    let activeClient: ExpoLocalFirstClient | null = null;

    async function boot() {
      try {
        setError(null);
        const storedRelayUrl =
          (await SecureStore.getItemAsync(RELAY_URL_STORAGE_KEY)) ??
          getDefaultRelayUrl();
        const nextClient = await ExpoLocalFirstClient.open({
          relayUrl: storedRelayUrl,
        });

        if (!active) {
          await nextClient.close();
          return;
        }

        activeClient = nextClient;
        setClient(nextClient);
        await publishClientState(nextClient);
      } catch (caughtError) {
        if (active) setError(getErrorMessage(caughtError));
      } finally {
        if (active) setIsBooting(false);
      }
    }

    void boot();

    return () => {
      active = false;
      void activeClient?.close();
    };
  }, [publishClientState]);

  const syncClient = useCallback(
    async (
      targetClient: ExpoLocalFirstClient,
      options?: { readonly localMutation?: boolean },
    ): Promise<SyncSummary | null> => {
      setIsSyncing(true);
      try {
        setError(null);
        const summary = await targetClient.sync();
        setSyncSummary(summary);
        await publishClientState(targetClient);
        return summary;
      } catch (caughtError) {
        const message = getErrorMessage(caughtError);
        setError(
          options?.localMutation ? `Saved locally. Sync failed: ${message}` : message,
        );

        if (options?.localMutation) return null;
        throw new Error(message);
      } finally {
        setIsSyncing(false);
      }
    },
    [publishClientState],
  );

  const runLocalMutation = useCallback(
    async (
      action: (targetClient: ExpoLocalFirstClient) => Promise<void>,
    ): Promise<void> => {
      if (!client) return;

      try {
        setError(null);
        await action(client);
        await publishClientState(client);
      } catch (caughtError) {
        const message = getErrorMessage(caughtError);
        setError(message);
        throw new Error(message);
      }

      await syncClient(client, { localMutation: true });
    },
    [client, publishClientState, syncClient],
  );

  const addEntry = useCallback(
    async (description: string, amountCents: number) => {
      await runLocalMutation(async (targetClient) => {
        await targetClient.addEntry(description, amountCents);
      });
    },
    [runLocalMutation],
  );

  const deleteEntry = useCallback(
    async (id: string) => {
      await runLocalMutation(async (targetClient) => {
        await targetClient.deleteEntry(id);
      });
    },
    [runLocalMutation],
  );

  const seedSample = useCallback(async () => {
    await runLocalMutation(async (targetClient) => {
      await targetClient.addEntry("Groceries", -5231);
      await targetClient.addEntry("Paycheck", 250000);
      await targetClient.addEntry("Coffee", -450);
    });
  }, [runLocalMutation]);

  const syncNow = useCallback(async () => {
    if (!client) return;
    await syncClient(client);
  }, [client, syncClient]);

  const resetDemo = useCallback(async () => {
    await runLocalMutation(async (targetClient) => {
      await targetClient.resetOwnerAndLocalData();
      setSyncSummary(null);
    });
  }, [runLocalMutation]);

  const restoreFromRecoveryKey = useCallback(
    async (nextRecoveryKey: string) => {
      if (!client) return;

      setIsSyncing(true);
      try {
        setError(null);
        await client.restoreFromRecoveryKey(nextRecoveryKey);
        await publishClientState(client);

        const summary = await client.sync();
        setSyncSummary(summary);
        await publishClientState(client);

        const restoredEntryCount = await client.getEntryCount();
        if (summary.pulled === 0 && restoredEntryCount === 0) {
          setError(
            "Recovery key restored, but this relay has no synced data for it yet.",
          );
        }
      } catch (caughtError) {
        const message = getErrorMessage(caughtError);
        setError(message);
        await publishClientState(client).catch(() => undefined);
        throw new Error(message);
      } finally {
        setIsSyncing(false);
      }
    },
    [client, publishClientState],
  );

  const saveRelayUrl = useCallback(
    async (nextRelayUrl: string) => {
      const normalizedRelayUrl = normalizeRelayUrl(nextRelayUrl);
      await SecureStore.setItemAsync(RELAY_URL_STORAGE_KEY, normalizedRelayUrl);

      if (client) {
        client.setRelayUrl(normalizedRelayUrl);
        await publishClientState(client);
      } else {
        setRelayUrl(normalizedRelayUrl);
      }
    },
    [client, publishClientState],
  );

  const value = useMemo<LocalFirstDemoContextValue>(
    () => ({
      entries,
      balanceCents,
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
    }),
    [
      addEntry,
      balanceCents,
      deleteEntry,
      entries,
      entryCount,
      envelopeSample,
      error,
      hasMoreEntries,
      isBooting,
      isLoadingMoreEntries,
      isSyncing,
      loadMoreEntries,
      localDeviceId,
      ownerId,
      recoveryKey,
      relayUrl,
      resetDemo,
      restoreFromRecoveryKey,
      saveRelayUrl,
      seedSample,
      syncNow,
      syncSummary,
    ],
  );

  return (
    <LocalFirstDemoContext.Provider value={value}>
      {children}
    </LocalFirstDemoContext.Provider>
  );
}

export function useLocalFirstDemo(): LocalFirstDemoContextValue {
  const context = use(LocalFirstDemoContext);
  if (!context) {
    throw new Error(
      "useLocalFirstDemo must be used within LocalFirstDemoProvider.",
    );
  }
  return context;
}

export function getDefaultRelayUrl(): string {
  return Platform.OS === "android"
    ? "http://10.0.2.2:4100"
    : "http://localhost:4100";
}

function normalizeRelayUrl(relayUrl: string): string {
  const normalized = relayUrl.trim().replace(/\/$/u, "");
  if (!normalized) {
    throw new Error("Relay URL is required.");
  }
  return normalized;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
