import type { Config } from "drizzle-kit";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));

export default {
  schema: resolve(directory, "src/schema.ts"),
  out: resolve(directory, "migrations"),
  dialect: "postgresql",
  // Historical manual-migration bookkeeping is not part of the application
  // schema. Excluding it prevents `drizzle-kit push` from misidentifying it as
  // a candidate rename when it compares the development database.
  tablesFilter: ["!schema_migrations"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
} satisfies Config;
