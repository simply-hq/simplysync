import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <>
      <Stack
        screenOptions={{
          headerLargeTitle: true,
          headerShadowVisible: false,
          title: "Local First",
        }}
      />
      <StatusBar style="auto" />
    </>
  );
}
