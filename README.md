# Tech@NYU Coordinator

Bun/TypeScript Discord meeting coordinator. The implemented flow is:

`/setup` → organization-owned Google Calendar OAuth → `/meet plan` audience picker → private web planner → durable Inngest Calendar sync → Discord announcement and one-hour DMs.

## Discord commands

- `/setup`: Discord administrators open the server's setup dashboard and connect or replace the organization-owned Google coordinator account. Its primary Calendar owns every event.
- `/profile`: each person saves the unique email that receives invitations. They may optionally authorize a separate Google account for free/busy only.
- `/meet plan`: opens an ephemeral Discord mentionable picker for users and roles, then a one-time private web planner. The planner shows named busy blocks, supports 15-minute drag selection, and allows email-only guests after time selection.
- `/meet plan`: every server member may start a meeting. `/meet reschedule` and `/meet cancel` are restricted to the meeting creator. Rescheduling starts the same web planner after choosing a meeting ID. Google Calendar remains the source of truth and emails invitees.
- `/team create` creates a server-scoped, reusable team. Its membership is an internal snapshot of the Discord users and roles selected when it is edited; the same saved team can be used in both task creation and meeting planning.
- `/task create` opens a private draft: add individual Discord users, roles, or saved teams; choose an optional native Discord due date; then select **Create task**. Any server member may create a task. The creator can edit its audience, details, due date, or cancel it; each assignee independently marks their assignment done and chooses their own reminder policy.
- `/task preferences` controls the caller's default policy. An assignee can override it on one task: daily until done (the default), one day before, one hour before, or no reminder. Undated tasks never notify. Reminder DMs include **Mark done** and **Reminder settings**; failures remain visible to both the assignee and the task creator in `/task list` and the read-only task dashboard.

The RoomProvider interface is available in `@technyu/application`. The eLab/OnceHub adapter is deliberately discovery/handoff-only until an approved API and booking policy are available; it never reports an unverified booking as confirmed.

## Local development

1. Copy `.env.example` to `.env` and fill in the Discord and Google credentials.
2. Install packages: `bun install`.
3. Install Chromium once for the dedicated room worker: `bunx playwright install chromium`.
4. Set `NGROK_DOMAIN` to your reserved ngrok domain, then run `bun dev`. Turborepo starts the API, React planner build watcher, Playwright room workflow host, local Compose stack, and ngrok tunnel in one terminal TUI.
5. Once PostgreSQL is healthy, synchronize the local database directly from the Drizzle schema with `bun run db:push` in a second terminal.
6. Register commands with `bun scripts/register-discord-commands.ts`.

Use `bun run dev:api`, `bun run dev:infra`, or `bun run dev:rooms` to run one process alone. `bun run dev:infra` starts just the local PostgreSQL, Redis, and Inngest stack. `bun run typecheck` and `bun test` use Turbo's cache for the repository-wide check. `bun run db:push` is the canonical development schema command; `bun run db:studio` opens Drizzle Studio. `bun run db:migrate` is the production migration command and is run only by the API service before deployment.

`bun dev` is the public-development command. It requires `NGROK_DOMAIN`, starts ngrok with `--domain`, and exports `APP_BASE_URL=https://$NGROK_DOMAIN` to every Turbo task. Use that stable origin for Discord's interaction endpoint and Google's redirect URI. Use `bun run dev:local` when no public tunnel is wanted.

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` belong to the coordinator application, not to each Discord server. Configure one Google OAuth web client with `${APP_BASE_URL}/oauth/google/callback` as an authorized redirect URI. `TOKEN_ENCRYPTION_KEY_BASE64` is a random 32-byte base64 secret used to encrypt refresh tokens at rest (for example: `openssl rand -base64 32`).

`bun dev` also starts Inngest at `http://localhost:8288`. The API uses `INNGEST_BASE_URL=http://localhost:8288`; Inngest persists in the dedicated `inngest` database inside the same local PostgreSQL container as the Coordinator database. The local Compose service at `infra/local/compose.yml` explicitly syncs its function endpoints from `http://host.docker.internal:3000/api/inngest` and `http://host.docker.internal:3001/api/inngest`, then polls every two seconds to survive watcher restarts. Set the same `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` in the application and Compose environment. Ngrok is only needed for Discord and Google to reach the API, not for Inngest.

To reset local state, run `docker compose --env-file .env -f infra/local/compose.yml down -v`, then `bun run dev:infra` and `bun run db:push`. The PostgreSQL initialization script creates the dedicated Inngest role and database only when its data directory is empty.

## Railway production

Production uses the API as the single public endpoint. The Vite planner remains a separate build workspace: Railway builds `apps/web/dist` as part of the API deployment, and the API serves it at `/plan/*`. It is not a standalone Railway service.

The self-hosted production workflow stack consists of the public API, private room worker, private Inngest image service, application PostgreSQL, dedicated Inngest PostgreSQL, and Redis. [`.railway/railway.ts`](.railway/railway.ts) is the single Railway infrastructure definition; it owns service sources, deploy settings, managed databases, and private-network references. The bootstrap process and Railway-managed secret inventory live in [`.railway/README.md`](.railway/README.md). The Vite workspace is deliberately not a Railway service.

## Job observability

The Turbo TUI is the primary development log surface. Calendar confirmation is asynchronous: it writes a durable outbox row, then immediately hands it to Inngest before responding to the caller. The confirmation waits only for that handoff (up to 1.5 seconds), not for Google Calendar to finish creating the event. The minute-level `outbox-sweep` workflow is recovery only: it retries rows that could not be handed off immediately. Logs are JSON and correlate the flow by `meetingId`, `outboxId`, or `roomBookingId`; they never include OAuth tokens or attendee emails.

For a successful calendar invitation, expect this sequence: `planner.confirm.calendar_sync_handoff` → `outbox.publish.accepted` → `calendar.sync.received` → `calendar.google.write.succeeded` → `calendar.sync.completed`. If handoff is temporarily unavailable, the caller is told that the invitation is queued for retry and the logs record `outbox.publish.deferred`; the recovery sweep will attempt the same durable outbox event again. The self-hosted Inngest dashboard at `http://localhost:8288` also shows the function run, steps, retries, and errors. `GET /health` on the API (`:3000`) and room worker (`:3001`) reports whether their Inngest configuration is present, without exposing secrets.

## Security boundaries

- `/setup`, organizer Calendar changes, and room-provider configuration may only be run by a Discord Administrator. Setup status is derived from the persisted Calendar connection, so rerunning `/setup` shows the current state rather than restarting setup.
- The organization-owned organizer account authorizes `calendar.events.owned`; events are created only on its primary calendar.
- Every coordinator-created Calendar event requests a Google Meet conference. Google may finish provisioning that link shortly after the initial invite is created.
- `/profile` records an invite email independently, then offers an optional Google connection with only `calendar.events.freebusy`. Reconnecting replaces the prior availability connection; disconnecting deletes it immediately.
- The planner launch link is redeemable once, then becomes a 24-hour HttpOnly browser session. The person holding that session can view the named availability snapshot for the session; busy intervals are never persisted.
- Direct Discord users and roles are the planning audience. Email-only guests are valid after a time is chosen; no roster sync is involved. Google sign-in remains optional for members and is used only for availability discovery.
- Task reminders are separate from Calendar. They use the task's source client as the notification route (Discord today), never email or the Web dashboard. A Discord DM action is authenticated against its specific assignment, so it remains safe even though Discord DMs do not identify a guild.
- `/setup` offers eLab / OnceHub configuration. Discord Administrators can also use `/provider configure`; requester data is saved per server. A room request is submitted only by the Discord user who started that room flow, and a successful OnceHub submission is treated as a pending request rather than an approved reservation.
