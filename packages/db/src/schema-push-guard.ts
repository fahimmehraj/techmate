type Environment = Record<string, string | undefined>;

export function assertLocalSchemaPush(environment: Environment = process.env) {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for db:push.");

  const runningOnRailway = Object.keys(environment).some((name) => name.startsWith("RAILWAY_"));
  if (runningOnRailway || environment.NODE_ENV === "production") {
    throw new Error("db:push is a local-development command and is disabled in Railway and production. Use db:migrate through the reviewed deployment path.");
  }

  const host = new URL(databaseUrl).hostname.toLowerCase();
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(host) && environment.ALLOW_NONLOCAL_DB_PUSH !== "1") {
    throw new Error(`db:push only targets a local database by default (received ${host}). Set ALLOW_NONLOCAL_DB_PUSH=1 only for an intentionally disposable development database.`);
  }
}
