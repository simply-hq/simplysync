import { describe, expect, test } from "bun:test";
import {
  withSimplySyncMetroConfig,
} from "../metro/index.cjs";

describe("React Native Metro config", () => {
  test("maps native crypto and removes Kysely's Node-only migration module", () => {
    const resolved: string[] = [];
    const config = withSimplySyncMetroConfig({ resolver: {} });
    const resolve = config.resolver?.resolveRequest;
    if (!resolve) throw new Error("Resolver was not installed.");
    const context = {
      originModulePath: "/app/node_modules/kysely/dist/esm/index.js",
      resolveRequest(
        _context: unknown,
        moduleName: string,
      ) {
        resolved.push(moduleName);
        return { moduleName };
      },
    };

    resolve(context, "crypto", "ios");
    resolve(
      context,
      "./migration/file-migration-provider.js",
      "ios",
    );
    resolve(context, "react", "ios");

    expect(resolved[0]).toBe("react-native-quick-crypto");
    expect(resolved[1]).toEndWith(
      "/metro/kysely-file-migration-provider.cjs",
    );
    expect(resolved[2]).toBe("react");
  });
});
