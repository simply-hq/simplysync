// Coverage for the React bindings' own surface — the context guard and the
// useSyncExternalStore wiring — which is where a binding bug (wrong snapshot,
// missing provider check) would live. The hooks are thin over engine methods
// that are tested in @simplysync/engine, so a minimal fake engine implementing
// just the methods the hooks call is enough; rendered with react-dom/server so
// no DOM or client renderer is needed. (Effect-level subscribe/unsubscribe
// behavior needs a DOM harness and is left to the engine's own tests, which
// cover the subscribe contract these hooks delegate to.)

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SyncProvider,
  useQuery,
  useSync,
  useSyncState,
  type Query,
  type SyncEngine,
  type SyncState,
} from "../src/index";

// A stand-in engine exposing only what the hooks under test call.
function fakeEngine(rows: readonly unknown[]): SyncEngine<Record<string, never>> {
  return {
    subscribeQuery: () => () => () => {},
    getQueryRows: () => rows,
    getSyncState: () => ({ type: "SyncStateSynced" }) as unknown as SyncState,
    subscribeSyncState: () => () => {},
    getError: () => null,
    subscribeError: () => () => {},
  } as unknown as SyncEngine<Record<string, never>>;
}

const DUMMY_QUERY = { sql: "select 1", parameters: [] } as unknown as Query<unknown>;

describe("@simplysync/react", () => {
  test("useSync throws a clear error outside a SyncProvider", () => {
    const Bad = () => createElement("div", null, String(useSync() != null));
    expect(() => renderToStaticMarkup(createElement(Bad))).toThrow(
      /must be used within a SyncProvider/,
    );
  });

  test("useSync returns the provided engine", () => {
    const engine = fakeEngine([]);
    const Show = () =>
      createElement("div", null, useSync() === engine ? "same" : "different");
    const html = renderToStaticMarkup(
      createElement(SyncProvider, { value: engine }, createElement(Show)),
    );
    expect(html).toContain("same");
  });

  test("useQuery renders the engine's current rows", () => {
    const engine = fakeEngine([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const List = () => createElement("div", null, `count:${useQuery(DUMMY_QUERY).length}`);
    const html = renderToStaticMarkup(
      createElement(SyncProvider, { value: engine }, createElement(List)),
    );
    expect(html).toContain("count:3");
  });

  test("useSyncState renders the engine's current sync state", () => {
    const engine = fakeEngine([]);
    const State = () =>
      createElement("div", null, (useSyncState() as { type: string }).type);
    const html = renderToStaticMarkup(
      createElement(SyncProvider, { value: engine }, createElement(State)),
    );
    expect(html).toContain("SyncStateSynced");
  });
});
