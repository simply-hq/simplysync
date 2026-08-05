import { useEffect } from "react";
import { AppState } from "react-native";
import {
  SyncProvider,
  type SyncEngine,
  type SyncProviderProps,
} from "@simplysync/react";

export interface ReactNativeSyncProviderProps {
  readonly value: SyncEngine<any>;
  readonly children: SyncProviderProps["children"];
  /** Sync when the app returns to the foreground. Default: true. */
  readonly syncOnActive?: boolean;
}

/**
 * The standard React provider plus React Native lifecycle integration. The
 * engine already polls while mounted; this closes the common stale-on-resume
 * gap after an OS suspends timers in the background.
 */
export function ReactNativeSyncProvider({
  value,
  children,
  syncOnActive = true,
}: ReactNativeSyncProviderProps) {
  useEffect(() => {
    if (!syncOnActive) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void value.sync().catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, [syncOnActive, value]);

  return <SyncProvider value={value}>{children}</SyncProvider>;
}
