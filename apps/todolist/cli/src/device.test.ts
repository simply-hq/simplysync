import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecoveryKey } from "@simplysync/protocol";
import { openDevice } from "./device";

function withTempDevice(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "simplysync-device-test-"));
  return run(directory).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

describe("canonical todo device safety", () => {
  test("rejects a device name that could escape its data directory", () =>
    withTempDevice(async (directory) => {
      await expect(
        openDevice({ name: "../outside", dataDir: directory }),
      ).rejects.toThrow("device names may contain only");
    }));

  test("refuses to attach an existing device database to another owner", () =>
    withTempDevice(async (directory) => {
      const existingRecoveryKey = await createRecoveryKey();
      const differentRecoveryKey = await createRecoveryKey();
      writeFileSync(
        join(directory, "phone.secrets.json"),
        JSON.stringify({ "phone:mnemonic": existingRecoveryKey }),
      );

      await expect(
        openDevice({
          name: "phone",
          dataDir: directory,
          recoveryKey: differentRecoveryKey,
        }),
      ).rejects.toThrow("already belongs to another owner");
    }));

  test("does not replace a missing key for an existing database", () =>
    withTempDevice(async (directory) => {
      writeFileSync(join(directory, "phone.db"), "");

      await expect(
        openDevice({ name: "phone", dataDir: directory }),
      ).rejects.toThrow("has local data but no recovery key");
    }));

  test("does not treat a corrupt secret file as an empty keychain", () =>
    withTempDevice(async (directory) => {
      writeFileSync(join(directory, "phone.secrets.json"), "{not-json");

      await expect(
        openDevice({ name: "phone", dataDir: directory }),
      ).rejects.toThrow("refusing to mint a replacement owner");
    }));
});
