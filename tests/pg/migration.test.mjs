/* initDatabase: a failing file leaves no trace, and concurrent boots run each
   file once. Fixtures are in ./fixtures — they used to live in /tmp, and when
   /tmp was cleared the rollback check kept passing with nothing to run. So the
   first assertion here is that the files were actually found. */
import { orm, connect, loadMigration, fixture, section, eq, rejects, done } from "./_harness.mjs";

const db = await connect();
const { initDatabase } = await loadMigration();

section("a failing migration rolls back");
await rejects(
  "stops at the broken file and throws",
  () => initDatabase({ migrations: fixture("migrations-rollback"), seeds: fixture("seeds-empty", { allowEmpty: true }) }),
  /already exists/,
);
eq("the good file ran and was recorded", (await db.query(`SELECT name FROM _migrations ORDER BY name`)).rows.map((r) => r.name), ["001_create.sql"]);
eq("the broken file left no column behind", (await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name = 'mig_demo' ORDER BY 1`,
)).rows.map((r) => r.column_name), ["id"]);

section("three boots at once");
await db.query(`DROP TABLE IF EXISTS _migrations, _seeds, race_demo`);
const opts = { migrations: fixture("migrations-race"), seeds: fixture("seeds-empty", { allowEmpty: true }) };
const results = await Promise.allSettled([initDatabase(opts), initDatabase(opts), initDatabase(opts)]);
eq("none fails", results.filter((r) => r.status === "rejected").length, 0);
eq("the file ran once", (await db.query(`SELECT count(*)::int AS n FROM race_demo`)).rows[0].n, 1);

void orm;
await done();
