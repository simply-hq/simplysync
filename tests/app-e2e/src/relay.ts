// Reuse the relay-conformance launcher verbatim: it resolves the Go relay via
// its own import.meta.url, so importing it from here still finds relays/go.
// Keeping one launcher avoids two subtly-different ways to boot the relay.
export {
  launchRelay,
  isGoAvailable,
  cleanupGoBinary,
  type LaunchedRelay,
} from "../../relay-conformance/test/conformance/launch-relay.ts";
