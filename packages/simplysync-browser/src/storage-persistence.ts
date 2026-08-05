export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  return (await navigator.storage?.persist?.()) ?? false;
}
