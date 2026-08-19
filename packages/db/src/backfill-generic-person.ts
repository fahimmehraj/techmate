import { sql } from "./client.ts";
import type { TransactionSql } from "postgres";

type Summary = {
  organizations: number;
  blockedOrganizations: number;
  usersMapped: number;
  membersMapped: number;
  endpointsCreated: number;
};

const validateOnly = process.argv.includes("--validate");
const batchSize = parseBatchSize(process.env.GENERIC_PERSON_BACKFILL_BATCH_SIZE);

try {
  const summary = validateOnly ? await validateGenericPersonMigration() : await backfillGenericPeople(batchSize);
  console.log(JSON.stringify(summary));
} finally {
  await sql.end();
}

/**
 * The lock prevents competing deploy jobs from selecting a different person
 * for the same legacy record. A conflict is recorded, never auto-merged.
 */
export async function backfillGenericPeople(limit = 100): Promise<Summary> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext('technyu-coordinator/generic-person-backfill'))");
    const [run] = await tx<{ id: string }[]>`INSERT INTO generic_person_migration_runs (status) VALUES ('running') RETURNING id`;
    if (!run) throw new Error("Unable to create generic-person migration run.");
    const organizations = await tx<{ id: string; discord_guild_id: string | null }[]>`
      SELECT o.id, o.discord_guild_id
      FROM organizations o
      WHERE NOT EXISTS (
        SELECT 1 FROM generic_person_migration_progress p
        WHERE p.organization_id = o.id AND p.phase = 'completed'
      )
      ORDER BY o.id
      LIMIT ${limit}
    `;
    const summary: Summary = { organizations: organizations.length, blockedOrganizations: 0, usersMapped: 0, membersMapped: 0, endpointsCreated: 0 };

    for (const organization of organizations) {
      const conflictCount = await recordConflicts(tx, organization.id);
      if (conflictCount) {
        summary.blockedOrganizations += 1;
        await tx`
          INSERT INTO generic_person_migration_progress (organization_id, run_id, phase, updated_at)
          VALUES (${organization.id}, ${run.id}, 'blocked', now())
          ON CONFLICT (organization_id) DO UPDATE SET run_id = EXCLUDED.run_id, phase = EXCLUDED.phase, updated_at = now()
        `;
        continue;
      }

      await ensureDiscordIntegration(tx, organization.id, organization.discord_guild_id);
      const before = await countMappings(tx, organization.id);
      await mapLegacyMembersAndUsers(tx, organization.id);
      await mapDiscordIdentities(tx, organization.id);
      await createEndpoints(tx, organization.id);
      await projectGenericReferences(tx, organization.id);
      const after = await countMappings(tx, organization.id);
      summary.usersMapped += after.users - before.users;
      summary.membersMapped += after.members - before.members;
      summary.endpointsCreated += after.endpoints - before.endpoints;
      await tx`
        INSERT INTO generic_person_migration_progress (organization_id, run_id, phase, updated_at)
        VALUES (${organization.id}, ${run.id}, 'completed', now())
        ON CONFLICT (organization_id) DO UPDATE SET run_id = EXCLUDED.run_id, phase = EXCLUDED.phase, updated_at = now()
      `;
    }

    await tx`UPDATE generic_person_migration_runs SET status = 'completed', completed_at = now(), summary = ${JSON.stringify(summary)}::jsonb WHERE id = ${run.id}`;
    return summary;
  });
}

/** Returns counts and throws only for invariant violations, never for an empty database. */
export async function validateGenericPersonMigration() {
  const checks = await sql<{
    active_legacy_without_person: string;
    duplicate_calendar_invite_endpoints: string;
    future_meetings_without_generic_owner: string;
    calendar_connections_without_person: string;
    oauth_states_without_person: string;
    unresolved_conflicts: string;
  }[]>`
    SELECT
      (SELECT count(*) FROM users WHERE status = 'active' AND person_id IS NULL)
        + (SELECT count(*) FROM members WHERE status = 'active' AND person_id IS NULL) AS active_legacy_without_person,
      (SELECT count(*) FROM (
        SELECT organization_id, address FROM notification_endpoints
        WHERE driver_id = 'email' AND status = 'active'
        GROUP BY organization_id, address HAVING count(*) > 1
      ) duplicates) AS duplicate_calendar_invite_endpoints,
      (SELECT count(*) FROM meetings WHERE starts_at > now() AND created_by_person_id IS NULL) AS future_meetings_without_generic_owner,
      (SELECT count(*) FROM calendar_connections WHERE kind = 'availability' AND person_id IS NULL) AS calendar_connections_without_person,
      (SELECT count(*) FROM oauth_states WHERE person_id IS NULL) AS oauth_states_without_person,
      (SELECT count(*) FROM generic_person_migration_conflicts WHERE resolved_at IS NULL) AS unresolved_conflicts
  `;
  const result = checks[0];
  if (!result) throw new Error("Generic-person migration validation did not return a result.");
  const failures = Object.entries(result).filter(([, value]) => Number(value) > 0);
  if (failures.length) throw new Error(`Generic-person cutover validation failed: ${failures.map(([name, value]) => `${name}=${value}`).join(", ")}`);
  return result;
}

async function recordConflicts(tx: TransactionSql, organizationId: string) {
  await tx.unsafe(`
    INSERT INTO generic_person_migration_conflicts (organization_id, kind, legacy_user_id, legacy_member_id, detail)
    SELECT u.organization_id, 'user_member_person_mismatch', u.id, m.id,
      jsonb_build_object('user_person_id', u.person_id, 'member_person_id', m.person_id)
    FROM users u
    JOIN members m ON m.id = u.member_id
    WHERE u.organization_id = '${organizationId}'::uuid
      AND u.person_id IS NOT NULL AND m.person_id IS NOT NULL AND u.person_id <> m.person_id
    ON CONFLICT DO NOTHING
  `);
  const rows = await tx<{ count: string }[]>`SELECT count(*) FROM generic_person_migration_conflicts WHERE organization_id = ${organizationId} AND resolved_at IS NULL`;
  return Number(rows[0]?.count ?? 0);
}

async function ensureDiscordIntegration(tx: TransactionSql, organizationId: string, guildId: string | null) {
  if (!guildId) return;
  await tx.unsafe(`
    INSERT INTO organization_client_integrations (organization_id, kind, status)
    SELECT '${organizationId}'::uuid, 'discord', 'active'
    WHERE NOT EXISTS (SELECT 1 FROM discord_integration_configs WHERE guild_id = '${escapeSql(guildId)}')
  `);
  await tx.unsafe(`
    INSERT INTO discord_integration_configs (integration_id, guild_id)
    SELECT i.id, '${escapeSql(guildId)}'
    FROM organization_client_integrations i
    WHERE i.organization_id = '${organizationId}'::uuid AND i.kind = 'discord'
      AND NOT EXISTS (SELECT 1 FROM discord_integration_configs WHERE guild_id = '${escapeSql(guildId)}')
    ORDER BY i.created_at LIMIT 1
    ON CONFLICT DO NOTHING
  `);
}

async function mapLegacyMembersAndUsers(tx: TransactionSql, organizationId: string) {
  // A member gives us the best stable display name and invite email. The
  // person is created only when neither side already selected one.
  await tx.unsafe(`
    INSERT INTO organization_people (organization_id, display_name, invitation_email, status)
    SELECT m.organization_id, m.display_name, lower(m.calendar_invite_email), CASE WHEN m.status = 'active' THEN 'active' ELSE 'inactive' END
    FROM members m
    WHERE m.organization_id = '${organizationId}'::uuid AND m.person_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM organization_people p
        WHERE p.organization_id = m.organization_id AND p.invitation_email = lower(m.calendar_invite_email)
      )
  `);
  await tx.unsafe(`
    UPDATE members m SET person_id = p.id
    FROM organization_people p
    WHERE m.organization_id = '${organizationId}'::uuid AND m.person_id IS NULL
      AND p.organization_id = m.organization_id AND p.invitation_email = lower(m.calendar_invite_email)
  `);
  await tx.unsafe(`
    INSERT INTO organization_people (organization_id, display_name, status)
    SELECT u.organization_id, coalesce(m.display_name, 'Organization person'), CASE WHEN u.status = 'active' THEN 'active' ELSE 'inactive' END
    FROM users u LEFT JOIN members m ON m.id = u.member_id
    WHERE u.organization_id = '${organizationId}'::uuid AND u.person_id IS NULL AND u.member_id IS NULL
  `);
  await tx.unsafe(`
    UPDATE users u SET person_id = m.person_id
    FROM members m
    WHERE u.organization_id = '${organizationId}'::uuid AND u.person_id IS NULL AND u.member_id = m.id AND m.person_id IS NOT NULL
  `);
  // Unregistered legacy users are linked by their Discord identity below; if
  // none exists they deliberately remain a validation failure rather than an
  // arbitrary merge.
}

async function mapDiscordIdentities(tx: TransactionSql, organizationId: string) {
  await tx.unsafe(`
    INSERT INTO integration_identities (integration_id, person_id, external_subject_id)
    SELECT i.id, u.person_id, ci.subject_id
    FROM client_identities ci
    JOIN users u ON u.id = ci.user_id
    JOIN organization_client_integrations i ON i.organization_id = u.organization_id AND i.kind = ci.client
    WHERE u.organization_id = '${organizationId}'::uuid AND u.person_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `);
  await tx.unsafe(`
    UPDATE users u SET person_id = ii.person_id
    FROM client_identities ci
    JOIN organization_client_integrations i ON i.organization_id = u.organization_id AND i.kind = ci.client
    JOIN integration_identities ii ON ii.integration_id = i.id AND ii.external_subject_id = ci.subject_id
    WHERE u.id = ci.user_id AND u.organization_id = '${organizationId}'::uuid AND u.person_id IS NULL
  `);
}

async function createEndpoints(tx: TransactionSql, organizationId: string) {
  await tx.unsafe(`
    INSERT INTO notification_endpoints (organization_id, driver_id, address, configuration)
    SELECT m.organization_id, 'email', lower(m.calendar_invite_email), '{}'::jsonb
    FROM members m WHERE m.organization_id = '${organizationId}'::uuid AND m.person_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `);
  await tx.unsafe(`
    INSERT INTO person_notification_endpoint_bindings (person_id, endpoint_id, purpose)
    SELECT m.person_id, e.id, 'calendar_invite'
    FROM members m JOIN notification_endpoints e ON e.organization_id = m.organization_id AND e.driver_id = 'email' AND e.address = lower(m.calendar_invite_email) AND e.integration_id IS NULL
    WHERE m.organization_id = '${organizationId}'::uuid AND m.person_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `);
  await tx.unsafe(`
    INSERT INTO notification_endpoints (organization_id, integration_id, driver_id, address, configuration)
    SELECT u.organization_id, ii.integration_id, 'discord.dm', ii.external_subject_id, '{}'::jsonb
    FROM users u JOIN integration_identities ii ON ii.person_id = u.person_id
    JOIN organization_client_integrations i ON i.id = ii.integration_id AND i.kind = 'discord'
    WHERE u.organization_id = '${organizationId}'::uuid AND u.person_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `);
  await tx.unsafe(`
    INSERT INTO person_notification_endpoint_bindings (person_id, endpoint_id, purpose)
    SELECT u.person_id, e.id, 'direct_notification'
    FROM users u JOIN integration_identities ii ON ii.person_id = u.person_id
    JOIN notification_endpoints e ON e.integration_id = ii.integration_id AND e.driver_id = 'discord.dm' AND e.address = ii.external_subject_id
    WHERE u.organization_id = '${organizationId}'::uuid AND u.person_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `);
}

async function projectGenericReferences(tx: TransactionSql, organizationId: string) {
  const org = `'${organizationId}'::uuid`;
  await tx.unsafe(`UPDATE meetings m SET created_by_person_id = u.person_id FROM users u WHERE m.organization_id = ${org} AND m.created_by_user_id = u.id AND m.created_by_person_id IS NULL`);
  await tx.unsafe(`UPDATE planning_sessions s SET created_by_person_id = u.person_id FROM users u WHERE s.organization_id = ${org} AND s.created_by_user_id = u.id AND s.created_by_person_id IS NULL`);
  await tx.unsafe(`UPDATE meeting_participants p SET person_id = m.person_id FROM members m JOIN meetings mt ON mt.id = p.meeting_id WHERE mt.organization_id = ${org} AND p.member_id = m.id AND p.person_id IS NULL`);
  await tx.unsafe(`UPDATE planning_attendees a SET person_id = coalesce(u.person_id, m.person_id) FROM planning_sessions s LEFT JOIN users u ON u.id = a.user_id LEFT JOIN members m ON m.id = a.member_id WHERE a.planning_session_id = s.id AND s.organization_id = ${org} AND a.person_id IS NULL`);
  await tx.unsafe(`UPDATE calendar_connections c SET person_id = m.person_id FROM members m WHERE c.organization_id = ${org} AND c.member_id = m.id AND c.person_id IS NULL`);
  await tx.unsafe(`UPDATE oauth_states o SET person_id = u.person_id FROM users u WHERE o.organization_id = ${org} AND o.user_id = u.id AND o.person_id IS NULL`);
  await tx.unsafe(`UPDATE provider_installations p SET configured_by_person_id = u.person_id FROM users u WHERE p.organization_id = ${org} AND p.configured_by_user_id = u.id AND p.configured_by_person_id IS NULL`);
  await tx.unsafe(`UPDATE room_bookings b SET created_by_person_id = u.person_id FROM users u WHERE b.organization_id = ${org} AND b.created_by_user_id = u.id AND b.created_by_person_id IS NULL`);
}

async function countMappings(tx: TransactionSql, organizationId: string) {
  const rows = await tx<{ users: string; members: string; endpoints: string }[]>`SELECT
    (SELECT count(*) FROM users WHERE organization_id = ${organizationId} AND person_id IS NOT NULL) AS users,
    (SELECT count(*) FROM members WHERE organization_id = ${organizationId} AND person_id IS NOT NULL) AS members,
    (SELECT count(*) FROM notification_endpoints WHERE organization_id = ${organizationId}) AS endpoints`;
  return { users: Number(rows[0]?.users ?? 0), members: Number(rows[0]?.members ?? 0), endpoints: Number(rows[0]?.endpoints ?? 0) };
}

function parseBatchSize(value: string | undefined) {
  const parsed = Number(value ?? "100");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) throw new Error("GENERIC_PERSON_BACKFILL_BATCH_SIZE must be an integer from 1 to 1000.");
  return parsed;
}

function escapeSql(value: string) {
  return value.replaceAll("'", "''");
}
