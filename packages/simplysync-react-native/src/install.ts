import { install as installQuickCrypto } from "react-native-quick-crypto";

type ReactNativeGlobals = typeof globalThis & {
  DOMException?: typeof DOMException;
};

// Installs the native WebCrypto implementation the protocol needs. Import
// `@simplysync/react-native/install` from the application's entry file before
// importing the engine.
installQuickCrypto();

const globals = globalThis as ReactNativeGlobals;
if (typeof globals.DOMException === "undefined") {
  globals.DOMException = class DOMExceptionPolyfill extends Error {
    constructor(message = "", name = "Error") {
      super(message);
      this.name = name;
    }
  } as unknown as typeof DOMException;
}
