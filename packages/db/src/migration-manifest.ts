export type MigrationSafety = "legacy" | "automatic";

export type MigrationDefinition = {
  name: string;
  safety: MigrationSafety;
};

/**
 * `legacy` is deliberately a closed set. Those files predate the live-data
 * migration policy and are retained solely to bootstrap a fresh database.
 * Every new production migration must be `automatic` and satisfy the checks
 * below, or be carried out through an explicitly approved manual runbook.
 */
export const migrationDefinitions = [
  { name: "0000_initial.sql", safety: "legacy" },
  { name: "0001_room_providers.sql", safety: "legacy" },
  { name: "0002_interactive_planner.sql", safety: "legacy" },
  { name: "0003_simplify_authorization_and_setup.sql", safety: "legacy" },
  { name: "0004_outbox.sql", safety: "legacy" },
  { name: "0005_client_integrations.sql", safety: "legacy" },
  { name: "0006_web_sessions.sql", safety: "legacy" },
  { name: "0007_tasks_and_teams.sql", safety: "legacy" },
  { name: "0008_generic_person_shadow.sql", safety: "automatic" },
  { name: "0009_notification_endpoints_and_audience_audit.sql", safety: "automatic" },
] as const satisfies readonly MigrationDefinition[];

export type LoadedMigration = MigrationDefinition & {
  source: string;
  checksum: string;
};

export async function loadMigrations(): Promise<LoadedMigration[]> {
  return Promise.all(migrationDefinitions.map(async (definition) => {
    const source = await Bun.file(new URL(`../migrations/${definition.name}`, import.meta.url)).text();
    assertAutomaticMigrationSafety(definition, source);
    return { ...definition, source, checksum: await checksum(source) };
  }));
}

export function assertAutomaticMigrationSafety(definition: MigrationDefinition, source: string) {
  if (definition.safety === "legacy") return;

  const sql = withoutComments(source);
  const forbidden = [
    ["DROP", /\bDROP\b/i],
    ["TRUNCATE", /\bTRUNCATE\b/i],
    // Foreign-key actions such as `ON DELETE SET NULL` are additive schema
    // declarations, not data deletion. Actual DELETE statements remain
    // forbidden in automatic migrations.
    ["DELETE", /\bDELETE\b(?!\s+(?:CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))/i],
    ["UPDATE", /\bUPDATE\b/i],
    ["ALTER TABLE ... ALTER COLUMN", /\bALTER\s+TABLE\b[\s\S]*?\bALTER\s+COLUMN\b/i],
    ["CREATE INDEX CONCURRENTLY", /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i],
  ].find(([, pattern]) => (pattern as RegExp).test(sql));

  if (forbidden) {
    throw new Error(`${definition.name} is an automatic migration but contains ${forbidden[0]}. Use an additive migration or an approved manual runbook.`);
  }
}

export function assertMigrationMayApply(migration: MigrationDefinition, existingDatabase: boolean) {
  if (existingDatabase && migration.safety === "legacy") {
    throw new Error(`Refusing to automatically apply legacy migration ${migration.name} to an existing database. Audit and record its state manually before continuing.`);
  }
}

function withoutComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

async function checksum(source: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
