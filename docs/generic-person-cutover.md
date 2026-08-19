# Generic-person cutover

The normal deploy applies `0008_generic_person_shadow.sql` and
`0009_notification_endpoints_and_audience_audit.sql` only. They are additive
and do not delete or rewrite live data.

Before a reviewed cutover, run the following against the production release
that includes the compatibility code:

```sh
bun run db:backfill-generic
bun run db:validate-generic
```

The backfill holds `technyu-coordinator/generic-person-backfill` for its whole
transaction and records blockers in `generic_person_migration_conflicts`.
Resolve those records explicitly; it never merges Discord identities or email
addresses on its own. Re-running the command is safe and resumes unfinished
organizations.

Do not start the destructive cutover until all of these are true:

- Validation exits successfully and has no unresolved conflicts.
- A 24-hour compatibility/parity observation window has no actor or audience
  mismatch.
- API, workflow, and room-worker releases all report the generic model version.
- Maintenance mode is enabled for planner, task, and profile mutations.

The final column/table removal is intentionally not part of `db:migrate`.
It is irreversible on Railway's live database and requires an approved,
environment-specific runbook. Record its reviewed checksum in
`manual_schema_migrations` before reopening writes. Fresh-database bootstrap
uses the post-cutover schema release; it must not reuse the compatibility
schema after that point.
