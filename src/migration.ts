/* eslint-disable @typescript-eslint/no-explicit-any */
/* `node:` prefixed, so what they are is legible at the import and no
   bundler mistakes them for packages it should try to resolve. */
import fs from "node:fs/promises";
import path from "node:path";
import { DataSource } from "./data-source";
import { SchemaBuilder } from "./query-builder";
import { currentLogger } from "./logger";
import { withLock } from "./lock";

const connection = new DataSource();

/**
 * Creates the table that records which files have run.
 *
 * No surrogate id. The file name IS the key — it was already `UNIQUE NOT NULL`,
 * and the `SERIAL` beside it was never read by anything. Dropping it also drops
 * the only Postgres-specific word in the statement.
 */
async function ensureTrackingTable(tableName: string) {
  const q = (name: string) => DataSource.dialect.quote(name);

  await connection.query(
    `CREATE TABLE IF NOT EXISTS ${q(tableName)} (
       ${q("name")} TEXT PRIMARY KEY,
       ${q("created_at")} TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,
  );
}

async function runSqlFiles(dirPath: string, trackingTable: string) {
  await ensureTrackingTable(trackingTable);

  let files: string[];
  try {
    files = await fs.readdir(dirPath);
  } catch {
    /* No such directory. A project with no migrations of this kind is the
       ordinary case, not a failure — the alternative is every app having to
       create empty folders to start. */
    return;
  }

  /* Sorted by name, which is why migrations are numbered: `001_`, `002_`.
     Order is the whole contract — a migration that runs before the one it
     depends on fails, and one that runs after a later edit corrupts. */
  const sqlFiles = files.filter(f => f.endsWith(".sql")).sort();

  if (sqlFiles.length === 0) return;

  const result = await connection.query(`SELECT name FROM ${DataSource.dialect.quote(trackingTable)}`);
  const executedFiles = new Set(result.rows.map(row => row.name));

  for (const file of sqlFiles) {
    if (executedFiles.has(file)) continue;

    currentLogger().info(`[DB] Running ${trackingTable}: ${file}...`);
    const sql = await fs.readFile(path.join(dirPath, file), "utf-8");

    try {
      /* One transaction, on ONE connection.
       *
       * This used to be four separate `connection.query` calls — BEGIN, the
       * migration, the INSERT, COMMIT — and `connection.query` goes through the
       * pool, which hands out whichever connection is free per statement. So
       * BEGIN could open a transaction on one connection and see it returned to
       * the pool still open, the migration could run on a second in autocommit,
       * and COMMIT could land on a third with nothing to commit.
       *
       * It looked fine forever, because a quiet pool keeps handing back the same
       * connection. Under concurrency it comes apart, and the way it comes apart
       * is the worst available: the schema change applies but the tracking row
       * does not, so the next boot runs the file again and fails on `already
       * exists`.
       *
       * `transaction()` keeps one connection checked out for the whole callback.
       */
      await DataSource.transaction(async (tx) => {
        await tx.query(sql);
        await tx.query(
          `INSERT INTO ${DataSource.dialect.quote(trackingTable)} (${DataSource.dialect.quote("name")}) ` +
            `VALUES (${DataSource.dialect.placeholder(1)})`,
          [file],
        );
      });

      currentLogger().info(`[DB] Successfully ran ${file}`);
    } catch (error) {
      currentLogger().error(`[DB] Failed to run ${file}:`, error);
      /* Stop at the first failure. Carrying on would run later migrations
         against a schema the failed one was supposed to produce, turning one
         readable error into a series of unrelated ones. */
      throw error;
    }
  }
}

export async function syncEntities(entityClasses: any[]) {
  currentLogger().info("[DB] Syncing schemas from entities...");
  const schemaBuilder = new SchemaBuilder(connection);
  for (const EntityClass of entityClasses) {
    if (EntityClass.entityName && EntityClass.schema) {
      try {
        await schemaBuilder.syncSchema(EntityClass.entityName, EntityClass.schema, EntityClass);
        currentLogger().info(`[DB] Synced schema for ${EntityClass.name || EntityClass.entityName}`);
      } catch (error) {
        currentLogger().error(`[DB] Failed to run sync query for ${EntityClass.name || EntityClass.entityName}:`, error);
        throw error;
      }
    }
  }
}

export interface InitDatabaseOptions {
  /** Directory of numbered `.sql` migrations. Default: `migrations` under the working directory. */
  migrations?: string;
  /** Directory of `.sql` seeds. Default: `seeds` under the working directory. */
  seeds?: string;
}

/**
 * Applies migrations, then seeds.
 *
 * Both directories are arguments. They used to be hardcoded — and to two
 * different conventions, `src/core/db/migrations` against a bare `seeds` —
 * which made a library impose one project's folder layout on every other. The
 * defaults are still relative to `process.cwd()`, which is worth knowing about:
 * under a Next.js `output: "standalone"` build, that is wherever the process
 * was started from, not the repository root. Pass absolute paths when the
 * answer has to be certain.
 */
export async function initDatabase(options: InitDatabaseOptions = {}) {
  /* A failed connection used to `return` here, so a database that was not ready
     produced a silent success: the app booted on an unmigrated schema and the
     real error surfaced somewhere far away, wearing a different name. */
  try {
    await connection.query("SELECT 1");
  } catch (error) {
    currentLogger().error("[DB] Connection failed; migrations did not run.", error);
    throw error;
  }

  const migrationsDir = options.migrations ?? path.join(process.cwd(), "migrations");
  const seedsDir = options.seeds ?? path.join(process.cwd(), "seeds");

  await withLock("ecosy:orm:migrate", async () => {
    currentLogger().info("[DB] Connected. Checking migrations...");
    await runSqlFiles(migrationsDir, "_migrations");

    currentLogger().info("[DB] Checking seeds...");
    await runSqlFiles(seedsDir, "_seeds");
  });
}
