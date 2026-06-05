import { install } from "react-native-quick-crypto";

install();

if (typeof globalThis.btoa === "undefined") {
  globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
}

if (typeof globalThis.atob === "undefined") {
  globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");
}

if (typeof globalThis.DOMException === "undefined") {
  globalThis.DOMException = class DOMException extends Error {
    constructor(message = "", name = "Error") {
      super(message);
      this.name = name;
    }
  };
}
