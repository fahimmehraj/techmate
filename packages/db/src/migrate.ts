import { sql } from "./client.ts";

const migrations = ["0000_initial.sql", "0001_room_providers.sql", "0002_interactive_planner.sql", "0003_simplify_authorization_and_setup.sql", "0004_outbox.sql", "0005_client_integrations.sql", "0006_web_sessions.sql", "0007_tasks_and_teams.sql"] as const;
await sql.unsafe("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");

// Older local installs used 0000 before migration tracking existed.
const existingOrganizations = await sql<{ exists: boolean }[]>`SELECT to_regclass('public.organizations') IS NOT NULL AS exists`;
if (existingOrganizations[0]?.exists) await sql`INSERT INTO schema_migrations (name) VALUES ('0000_initial.sql') ON CONFLICT DO NOTHING`;

const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((row) => row.name));
for (const name of migrations) {
  if (applied.has(name)) continue;
  const source = await Bun.file(new URL(`../migrations/${name}`, import.meta.url)).text();
  await sql.begin(async (transaction) => {
    await transaction.unsafe(source);
    await transaction`INSERT INTO schema_migrations (name) VALUES (${name})`;
  });
  console.log(`Applied ${name}.`);
}
await sql.end();
