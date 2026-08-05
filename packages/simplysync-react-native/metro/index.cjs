const path = require("path");

const kyselyMigrationStub = path.join(
  __dirname,
  "kysely-file-migration-provider.cjs",
);

function isKyselyFileMigrationProvider(context, moduleName) {
  if (!moduleName.endsWith("migration/file-migration-provider.js")) {
    return false;
  }
  const origin = context.originModulePath.replaceAll("\\", "/");
  return origin.includes("/kysely/dist/esm/") ||
    origin.includes("/kysely/dist/cjs/");
}

/**
 * Adds the two resolver rules SimplySync needs on React Native:
 *
 * - Node's `crypto` import resolves to the native JSI implementation.
 * - Kysely's Node-only file migration provider is replaced with a clear
 *   unsupported stub. SimplySync owns its SQLite migrations and never uses it,
 *   but Metro otherwise includes the provider through Kysely's barrel export;
 *   its dynamic filesystem import cannot be compiled by Hermes.
 */
function withSimplySyncMetroConfig(config) {
  const resolver = config.resolver ?? {};
  const previousResolveRequest = resolver.resolveRequest;

  resolver.resolveRequest = (context, moduleName, platform) => {
    if (moduleName === "crypto") {
      return context.resolveRequest(
        context,
        "react-native-quick-crypto",
        platform,
      );
    }
    if (isKyselyFileMigrationProvider(context, moduleName)) {
      return context.resolveRequest(context, kyselyMigrationStub, platform);
    }
    if (previousResolveRequest) {
      return previousResolveRequest(context, moduleName, platform);
    }
    return context.resolveRequest(context, moduleName, platform);
  };

  config.resolver = resolver;
  return config;
}

module.exports = { withSimplySyncMetroConfig };
