import { sql } from "./client.ts";
import { assertMigrationMayApply, loadMigrations } from "./migration-manifest.ts";

const migrations = await loadMigrations();
const migrationByName = new Map(migrations.map((migration) => [migration.name, migration]));
const appliedNames: string[] = [];
const adoptedChecksums: string[] = [];

try {
  await sql.begin(async (transaction) => {
    // A transaction-scoped advisory lock keeps independently triggered
    // pre-deploy commands from ever applying migrations concurrently.
    await transaction.unsafe("SELECT pg_advisory_xact_lock(hashtext('technyu-coordinator/schema-migrations'))");
    await transaction.unsafe("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now())");
    await transaction.unsafe("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");

    // Older local installs used 0000 before migration tracking existed.
    const existingOrganizations = await transaction<{ exists: boolean }[]>`SELECT to_regclass('public.organizations') IS NOT NULL AS exists`;
    const existingDatabase = existingOrganizations[0]?.exists ?? false;
    if (existingDatabase) {
      const initialMigration = migrationByName.get("0000_initial.sql");
      if (!initialMigration) throw new Error("The initial migration is missing from the manifest.");
      await transaction`INSERT INTO schema_migrations (name, checksum) VALUES (${initialMigration.name}, ${initialMigration.checksum}) ON CONFLICT (name) DO NOTHING`;
    }

    const applied = await transaction<{ name: string; checksum: string | null }[]>`SELECT name, checksum FROM schema_migrations`;
    const unknown = applied.filter((migration) => !migrationByName.has(migration.name));
    if (unknown.length) throw new Error(`Database schema is newer than this deployment: unknown migration(s) ${unknown.map((migration) => migration.name).join(", ")}.`);

    for (const appliedMigration of applied) {
      const migration = migrationByName.get(appliedMigration.name);
      if (!migration) continue;
      if (appliedMigration.checksum && appliedMigration.checksum !== migration.checksum) {
        throw new Error(`Migration integrity check failed for ${migration.name}. Applied migrations are immutable.`);
      }
      if (!appliedMigration.checksum) {
        await transaction`UPDATE schema_migrations SET checksum = ${migration.checksum} WHERE name = ${migration.name} AND checksum IS NULL`;
        adoptedChecksums.push(migration.name);
      }
    }

    const appliedMigrationNames = new Set(applied.map((migration) => migration.name));
    for (const migration of migrations) {
      if (appliedMigrationNames.has(migration.name)) continue;
      assertMigrationMayApply(migration, existingDatabase);
      await transaction.unsafe(migration.source);
      await transaction`INSERT INTO schema_migrations (name, checksum) VALUES (${migration.name}, ${migration.checksum})`;
      appliedNames.push(migration.name);
    }
  });
} finally {
  await sql.end();
}

for (const name of adoptedChecksums) console.log(`Recorded checksum for previously applied ${name}.`);
for (const name of appliedNames) console.log(`Applied ${name}.`);
