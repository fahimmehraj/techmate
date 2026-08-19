import { loadMigrations } from "../packages/db/src/migration-manifest.ts";

await loadMigrations();

const railwayConfiguration = await Bun.file(new URL("../.railway/railway.ts", import.meta.url)).text();
if (!/preDeploy:\s*\[\s*"bun run db:migrate"\s*\]/.test(railwayConfiguration)) {
  throw new Error("Railway API deployments must run the versioned db:migrate command before deploying.");
}
if (railwayConfiguration.includes("db:push")) {
  throw new Error("Railway configuration must not run db:push.");
}
if (!railwayConfiguration.includes("bun scripts/check-production-safety.ts")) {
  throw new Error("Railway API builds must validate production migration safety before pre-deploy migrations run.");
}

console.log("Production migration and Railway deployment safeguards passed.");
