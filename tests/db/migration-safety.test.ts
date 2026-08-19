import { describe, expect, test } from "bun:test";
import { assertAutomaticMigrationSafety, assertMigrationMayApply, loadMigrations, migrationDefinitions } from "../../packages/db/src/migration-manifest.ts";
import { assertLocalSchemaPush } from "../../packages/db/src/schema-push-guard.ts";

describe("production migration safety", () => {
  test("keeps the pre-policy migration history explicitly frozen", () => {
    expect(migrationDefinitions.filter((migration) => migration.safety === "legacy").map((migration) => migration.name)).toEqual([
      "0000_initial.sql",
      "0001_room_providers.sql",
      "0002_interactive_planner.sql",
      "0003_simplify_authorization_and_setup.sql",
      "0004_outbox.sql",
      "0005_client_integrations.sql",
      "0006_web_sessions.sql",
      "0007_tasks_and_teams.sql",
    ]);
  });

  test("loads every manifest migration and validates new automatic migrations", async () => {
    await expect(loadMigrations()).resolves.toHaveLength(migrationDefinitions.length);
  });

  test("rejects destructive and non-transactional automatic migration statements", () => {
    expect(() => assertAutomaticMigrationSafety({ name: "0008_bad.sql", safety: "automatic" }, "ALTER TABLE users DROP COLUMN email;")).toThrow("DROP");
    expect(() => assertAutomaticMigrationSafety({ name: "0008_bad.sql", safety: "automatic" }, "UPDATE users SET name = 'changed';")).toThrow("UPDATE");
    expect(() => assertAutomaticMigrationSafety({ name: "0008_bad.sql", safety: "automatic" }, "CREATE INDEX CONCURRENTLY users_name_idx ON users(name);")).toThrow("CREATE INDEX CONCURRENTLY");
  });

  test("never applies a legacy migration to a populated database", () => {
    expect(() => assertMigrationMayApply({ name: "0002_interactive_planner.sql", safety: "legacy" }, true)).toThrow("Refusing to automatically apply legacy migration");
    expect(() => assertMigrationMayApply({ name: "0008_add_column.sql", safety: "automatic" }, true)).not.toThrow();
  });

  test("allows db:push only for local development databases", () => {
    expect(() => assertLocalSchemaPush({ DATABASE_URL: "postgres://postgres:postgres@localhost:5432/coordinator" })).not.toThrow();
    expect(() => assertLocalSchemaPush({ DATABASE_URL: "postgres://postgres:postgres@db.railway.internal:5432/coordinator", RAILWAY_PROJECT_ID: "project" })).toThrow("disabled in Railway");
    expect(() => assertLocalSchemaPush({ DATABASE_URL: "postgres://postgres:postgres@db.example.com:5432/coordinator" })).toThrow("only targets a local database");
  });
});
