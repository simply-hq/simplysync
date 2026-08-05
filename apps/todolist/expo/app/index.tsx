import { TodoScreen } from "@/components/todo-screen";
import { ReactNativeSyncProvider } from "@simplysync/react-native";
import { todoEngine } from "@/lib/todo-engine";

export default function Index() {
  return (
    <ReactNativeSyncProvider value={todoEngine}>
      <TodoScreen />
    </ReactNativeSyncProvider>
  );
}
