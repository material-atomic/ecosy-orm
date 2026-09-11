/**
 * Runs every *.test.mjs / *.test.cjs here, each in its own process, against a
 * database reserved for them. See README.md.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

const base = process.env.DATABASE_URL;
if (!base) {
  console.error(
    "Set DATABASE_URL to a Postgres server. The tests run in their own database, " +
      "ecosy_orm_test, never in the one it names.",
  );
  process.exit(2);
}

const TEST_DB = "ecosy_orm_test";
const target = new URL(base);
target.pathname = `/${TEST_DB}`;

const admin = new pg.Client({ connectionString: base });
await admin.connect();
const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [TEST_DB]);
if (!found.rowCount) await admin.query(`CREATE DATABASE ${TEST_DB}`);
await admin.end();

const dir = fileURLToPath(new URL(".", import.meta.url));
const only = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => /\.test\.(mjs|cjs)$/.test(f))
  .filter((f) => !only.length || only.some((o) => f.includes(o)))
  .sort();

if (!files.length) {
  console.error(`No test files matched${only.length ? ` ${only.join(", ")}` : ""}. Nothing ran, which is not a pass.`);
  process.exit(1);
}

const results = [];
for (const file of files) {
  /* A clean schema per file, so no file depends on what another left. */
  const reset = new pg.Client({ connectionString: target.toString() });
  await reset.connect();
  await reset.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await reset.end();

  console.log(`\n━━ ${file}`);
  const run = spawnSync(process.execPath, [`${dir}${file}`], {
    env: { ...process.env, TEST_DATABASE_URL: target.toString() },
    stdio: "inherit",
  });
  results.push({ file, ok: run.status === 0 });
}

console.log("\n━━ summary");
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.file}`);
const failedFiles = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failedFiles} of ${results.length} files passed`);
process.exit(failedFiles ? 1 : 0);
