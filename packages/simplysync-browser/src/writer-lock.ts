interface LockManagerLike {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<void>,
  ): Promise<void>;
}

export type BrowserWriterLockResult =
  | { readonly acquired: true; readonly release: () => Promise<void> }
  | { readonly acquired: false; readonly reason: "held" | "unsupported" };

export async function acquireWriterLock(
  name: string,
  manager: LockManagerLike | undefined,
): Promise<BrowserWriterLockResult> {
  if (!manager) return { acquired: false, reason: "unsupported" };

  let releaseHold: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let resolveAcquired: (value: boolean) => void = () => undefined;
  let rejectAcquired: (error: unknown) => void = () => undefined;
  const acquired = new Promise<boolean>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });

  const request = manager.request(
    `simplysync:${name}`,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      resolveAcquired(lock !== null);
      if (lock) await hold;
    },
  );
  void request.catch(rejectAcquired);

  if (!(await acquired)) return { acquired: false, reason: "held" };

  let released = false;
  return {
    acquired: true,
    async release() {
      if (released) return request;
      released = true;
      releaseHold();
      await request;
    },
  };
}

export function acquireBrowserWriterLock(name: string): Promise<BrowserWriterLockResult> {
  const manager =
    typeof navigator === "undefined"
      ? undefined
      : (navigator.locks as LockManagerLike | undefined);
  return acquireWriterLock(name, manager);
}
