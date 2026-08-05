# @simplysync/react

React context and hooks for a `@simplysync/engine` instance, including reactive
queries, sync state, relay diagnostics, and error state.

## Use from source

The `web` and `react-native` selective clone presets include this workspace and
its engine dependency. Run `bun install --no-save && bun run build` in the
resulting clone.

## Usage

```tsx
import {
  SyncProvider,
  useQuery,
  useSyncError,
  useSyncState,
} from "@simplysync/react";

const activeTodos = engine.createQuery((db) =>
  db.selectFrom("todo").selectAll().where("isDeleted", "=", 0),
);

function TodoList() {
  const todos = useQuery(activeTodos);
  const state = useSyncState();
  const error = useSyncError();

  return (
    <>
      <p>{state.type}</p>
      {error && <p role="alert">{error.message}</p>}
      {todos.map((todo) => <p key={todo.id}>{todo.title}</p>)}
    </>
  );
}

export function App() {
  return (
    <SyncProvider value={engine}>
      <TodoList />
    </SyncProvider>
  );
}
```

`useQuery` subscribes with `useSyncExternalStore`, so local writes and applied
remote changes both update React. `useRelayStatuses()` is intended for
diagnostics/settings UI rather than hot render paths because it probes each
configured relay.
