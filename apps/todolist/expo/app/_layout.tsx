import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <>
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerShown: false,
          title: "SimplySync Todos",
        }}
      />
      <StatusBar style="auto" />
    </>
  );
}
