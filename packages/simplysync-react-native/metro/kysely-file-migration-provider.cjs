class FileMigrationProvider {
  constructor() {
    throw new Error(
      "Kysely FileMigrationProvider is Node-only and unavailable in React Native.",
    );
  }
}

module.exports = { FileMigrationProvider };
