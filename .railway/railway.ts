import { defineRailway, github, group, image, postgres, project, redis, service } from "railway/iac";

const repository = "fahimmehraj/techmate";

const apiWatchPaths = [
  "/apps/api/**",
  "/apps/web/**",
  "/packages/**",
  "/package.json",
  "/bun.lock",
  "/bunfig.toml",
  "/turbo.json",
  "/tsconfig.json",
];

const roomWorkerWatchPaths = [
  "/apps/room-worker/**",
  "/packages/**",
  "/package.json",
  "/bun.lock",
  "/bunfig.toml",
  "/turbo.json",
  "/tsconfig.json",
];

export default defineRailway((ctx) => {
  const appPostgres = postgres("app-postgres");
  const inngestPostgres = postgres("inngest-postgres");
  const inngestRedis = redis("inngest-redis");

  const api = service("api", {
    source: github(repository, { branch: "main" }),
    build: {
      builder: "RAILPACK",
      buildCommand: "bun scripts/check-production-safety.ts && bun --filter @technyu/web build",
      watchPatterns: apiWatchPaths,
    },
    preDeploy: ["bun run db:migrate"],
    start: "bun --filter @technyu/api start",
    healthcheck: "/health",
    healthcheckTimeout: 60,
    replicas: 1,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    env: {
      PORT: "3000",
      APP_BASE_URL: "https://${{RAILWAY_PUBLIC_DOMAIN}}",
      DATABASE_URL: appPostgres.env.DATABASE_URL,
      DISCORD_PUBLIC_KEY: ctx.shared.DISCORD_PUBLIC_KEY,
      DISCORD_BOT_TOKEN: ctx.shared.DISCORD_BOT_TOKEN,
      GOOGLE_CLIENT_ID: ctx.shared.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: ctx.shared.GOOGLE_CLIENT_SECRET,
      TOKEN_ENCRYPTION_KEY_BASE64: ctx.shared.TOKEN_ENCRYPTION_KEY_BASE64,
      INNGEST_BASE_URL: "http://${{inngest.RAILWAY_PRIVATE_DOMAIN}}:8288",
      INNGEST_EVENT_KEY: ctx.shared.INNGEST_EVENT_KEY,
      INNGEST_SIGNING_KEY: ctx.shared.INNGEST_SIGNING_KEY,
      INNGEST_SERVE_HOST: "http://${{RAILWAY_PRIVATE_DOMAIN}}:3000",
    },
  });

  const roomWorker = service("room-worker", {
    source: github(repository, { branch: "main" }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "apps/room-worker/Dockerfile",
      watchPatterns: roomWorkerWatchPaths,
    },
    start: "bun --filter @technyu/room-worker start",
    healthcheck: "/health",
    healthcheckTimeout: 60,
    replicas: 1,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    env: {
      PORT: "3001",
      DATABASE_URL: appPostgres.env.DATABASE_URL,
      INNGEST_BASE_URL: "http://${{inngest.RAILWAY_PRIVATE_DOMAIN}}:8288",
      INNGEST_EVENT_KEY: ctx.shared.INNGEST_EVENT_KEY,
      INNGEST_SIGNING_KEY: ctx.shared.INNGEST_SIGNING_KEY,
      ROOM_INNGEST_SERVE_HOST: "http://${{RAILWAY_PRIVATE_DOMAIN}}:3001",
    },
  });

  const inngest = service("inngest", {
    source: image("inngest/inngest:v1.39.0"),
    start: "sh -c 'exec inngest start --port \"$PORT\" --sdk-url \"$API_INNGEST_SDK_URL\" --sdk-url \"$ROOM_INNGEST_SDK_URL\" --poll-interval 30'",
    replicas: 1,
    env: {
      PORT: "8288",
      API_INNGEST_SDK_URL: "http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3000/api/inngest",
      ROOM_INNGEST_SDK_URL: "http://${{room-worker.RAILWAY_PRIVATE_DOMAIN}}:3001/api/inngest",
      INNGEST_EVENT_KEY: ctx.shared.INNGEST_EVENT_KEY,
      INNGEST_SIGNING_KEY: ctx.shared.INNGEST_SIGNING_KEY,
      INNGEST_POSTGRES_URI: inngestPostgres.env.DATABASE_URL,
      INNGEST_REDIS_URI: inngestRedis.env.REDIS_URL,
    },
  });

  const coordinator = group("Coordinator", [appPostgres, api, roomWorker]);
  const workflows = group("Inngest", [inngestPostgres, inngestRedis, inngest]);

  return project("technyu-coordinator", {
    resources: [coordinator, workflows],
  });
});
