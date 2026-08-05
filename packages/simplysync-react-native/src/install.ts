import {
  Buffer,
  install as installQuickCrypto,
} from "react-native-quick-crypto";

type ReactNativeGlobals = typeof globalThis & {
  Buffer?: typeof Buffer;
  DOMException?: typeof DOMException;
};

/**
 * Installs the native WebCrypto/Buffer implementation needed by the protocol
 * and fills the two browser base64 globals used by its wire encoding.
 *
 * Import `@simplysync/react-native/install` from the application's entry file
 * before importing the engine. This module invokes the function automatically;
 * the named export exists for custom bootstraps and tests.
 */
export function installSimplySyncReactNative(): void {
  installQuickCrypto();

  if (typeof globalThis.btoa === "undefined") {
    globalThis.btoa = (value) =>
      Buffer.from(value, "binary").toString("base64");
  }
  if (typeof globalThis.atob === "undefined") {
    globalThis.atob = (value) =>
      Buffer.from(value, "base64").toString("binary");
  }

  const globals = globalThis as ReactNativeGlobals;
  if (typeof globals.DOMException === "undefined") {
    globals.DOMException = class DOMExceptionPolyfill extends Error {
      constructor(message = "", name = "Error") {
        super(message);
        this.name = name;
      }
    } as unknown as typeof DOMException;
  }
}

installSimplySyncReactNative();
