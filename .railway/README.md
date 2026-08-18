# Railway infrastructure

`.railway/railway.ts` is the only production-infrastructure definition. It creates the API, room worker, self-hosted Inngest service, application PostgreSQL, Inngest PostgreSQL, and Inngest Redis. The web planner is built into, and served by, the API; it is not a Railway service.

## Bootstrap

1. Create an empty Railway project named `technyu-coordinator` and its `production` environment, then connect the Railway GitHub integration to `fahimmehraj/techmate`.
2. Create a project-scoped Railway token and add it to the protected GitHub `railway-production` environment as `RAILWAY_TOKEN`.
3. From an authenticated maintainer terminal, run `railway link`, then `railway config plan` and `railway config apply`. Future committed infrastructure changes are applied by `.github/workflows/railway-infrastructure.yml` after merge to `main`.
4. Generate a public domain for `api`. `APP_BASE_URL` automatically resolves to that domain through `RAILWAY_PUBLIC_DOMAIN`; register its `/discord/interactions` and `/oauth/google/callback` URLs with Discord and Google.

## Railway-managed shared values

Set these in Railway, never in this repository or GitHub Actions: `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY_BASE64`, `INNGEST_EVENT_KEY`, and `INNGEST_SIGNING_KEY`.

`RAILWAY_TOKEN` is different: it is a scoped infrastructure-control credential used only by the protected CI workflow. It must not be provided to pull-request workflows.

Do not configure `railway.toml` or `railway.json` for the API or room worker. Railway does not allow those service-level configuration systems to coexist with project-level IaC.
