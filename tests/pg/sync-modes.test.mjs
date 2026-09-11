/* Additive by default, mirror on request, and a dry run that plans without
   writing — LandingBuilder's reason not to upgrade: 1.2.0 widened what sync
   removes, with no mode that only adds and no way to see first. */
import { orm, PgDriver, connect, section, eq, logs, said, done } from "./_harness.mjs";
const { DataSource, Entity, createRepository, SchemaBuilder } = orm;

const db = await connect();   // the package default
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const columns = async (t) => (await db.query(
  `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`, [t])).rows;
const constraints = async (t) => (await db.query(
  /* contype 'n': Postgres 18 records NOT NULL as a constraint of its own. */
  `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype <> 'n' ORDER BY conname`, [t])).rows.map((r) => r.conname);
const indexes = async (t) => (await db.query(`SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`, [t])).rows.map((r) => r.indexname);

const Parent = Entity.create("sm_parent", { columns: { id: { type: "INTEGER", primaryKey: true } } });
await createRepository(Parent).syncSchema();
await db.query(`INSERT INTO sm_parent VALUES (1)`);

const v1 = {
  columns: {
    id: { type: "SERIAL", primaryKey: true },
    name: { type: "TEXT", notNull: true },
    legacy: { type: "TEXT", notNull: true },
    score: { type: "INTEGER", notNull: true, default: "0" },
    email: { type: "TEXT", unique: true },
    parentId: { type: "INTEGER", name: "parent_id", references: "sm_parent(id)" },
  },
  indexes: [{ name: "sm_rows_name_idx", columns: ["name"] }],
  checks: [{ name: "sm_rows_score_ok", expression: "score >= 0" }],
};
const v2 = {
  columns: {
    id: { type: "SERIAL", primaryKey: true },
    name: { type: "TEXT", notNull: true },
    score: { type: "INTEGER", notNull: true },
    email: { type: "TEXT" },
    parentId: { type: "INTEGER", name: "parent_id" },
    nick: { type: "TEXT" },
  },
};

section("additive (the default): nothing the entity stopped declaring is removed");
await createRepository(Entity.create("sm_rows", v1)).syncSchema();
await db.query(`INSERT INTO sm_rows (name, legacy, email, parent_id) VALUES ('a', 'kept data', 'a@x', 1)`);
const before = { constraints: await constraints("sm_rows"), indexes: await indexes("sm_rows") };
logs.length = 0;
await createRepository(Entity.create("sm_rows", v2)).syncSchema();
const cols = await columns("sm_rows");
eq("the removed column is still there, with its data", (await one(`SELECT legacy FROM sm_rows`)).legacy, "kept data");
eq("…made nullable, so inserts that no longer mention it work", cols.find((c) => c.column_name === "legacy").is_nullable, "YES");
eq("an insert through the new entity succeeds", (await createRepository(Entity.create("sm_rows", v2)).insert({ name: "b", score: 1 })).name, "b");
eq("default, unique, foreign key, index and check are all still there", {
  default: cols.find((c) => c.column_name === "score").column_default,
  constraints: await constraints("sm_rows"),
  indexes: await indexes("sm_rows"),
}, { default: "0", constraints: before.constraints, indexes: before.indexes });
eq("what the entity added was added", cols.some((c) => c.column_name === "nick"), true);
eq("one warning names everything kept and how to remove it",
  said(/sm_rows: kept 6 things the entity no longer declares — .*column legacy.*Sync is additive.*mode: "mirror"/), true);
eq("the DROP NOT NULL on the kept column announced itself as it ran",
  said(/\[DB\] ran: ALTER TABLE "sm_rows" ALTER COLUMN "legacy" DROP NOT NULL/), true);
eq("…and the kept list says the column was made nullable", said(/column legacy \(made nullable\)/), true);
eq("the ADD COLUMN announced itself too", said(/\[DB\] ran: ALTER TABLE "sm_rows" ADD COLUMN "nick"/), true);
eq("a column kept while another was added gets the rename hint", said(/If nick is a rename of a kept column, the data stayed in the old one/), true);

section("additive still applies what the entity changed");
const v3 = { ...v2, checks: [{ name: "sm_rows_score_ok", expression: "score >= 0 AND score <= 100" }] };
await db.query(`COMMENT ON CONSTRAINT sm_rows_score_ok ON sm_rows IS 'score >= 0'`);
await createRepository(Entity.create("sm_rows", { ...v1, columns: { ...v1.columns, legacy: { type: "TEXT" } }, checks: v3.checks })).syncSchema();
eq("a changed check is replaced", /100/.test((await one(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'sm_rows_score_ok'`)).d), true);

section("mirror: the table becomes exactly what the entity says");
/* Row "b" was inserted while legacy was optional; v1 makes it required again,
   and sync rightly refuses NOT NULL over it until it holds something. */
await db.query(`UPDATE sm_rows SET legacy = 'filled' WHERE legacy IS NULL`);
await createRepository(Entity.create("sm_rows", v1)).syncSchema();
DataSource.driver(PgDriver({ connectionString: process.env.TEST_DATABASE_URL, sync: { mode: "mirror" } }));
await createRepository(Entity.create("sm_rows", v2)).syncSchema();
const mcols = await columns("sm_rows");
eq("the column is dropped, data and all", mcols.some((c) => c.column_name === "legacy"), false);
eq("default, unique, foreign key, index and check are gone", {
  default: mcols.find((c) => c.column_name === "score").column_default,
  constraints: await constraints("sm_rows"),
  indexes: await indexes("sm_rows"),
}, { default: null, constraints: ["sm_rows_pkey"], indexes: ["sm_rows_pkey"] });

section("dry run: plans, writes nothing");
{
  const snapshot = async () => ({ cols: await columns("sm_rows"), constraints: await constraints("sm_rows"), indexes: await indexes("sm_rows") });
  const beforePlan = await snapshot();
  let effectRan = false;
  class Planned extends Entity.create("sm_rows", v1) { static effects = [{ name: "never", when: "sync", run: () => { effectRan = true; } }]; }
  const planner = new SchemaBuilder(db, DataSource.dialect, { dryRun: true, mode: "mirror" });
  await planner.syncSchema("sm_rows", Planned.schema, Planned);
  eq("the database is exactly as it was", await snapshot(), beforePlan);
  eq("the plan lists what would run", [
    planner.planned.some((s) => /ADD COLUMN "legacy"/.test(s)),
    planner.planned.some((s) => /DROP COLUMN "nick"/.test(s)),
    planner.planned.some((s) => /ADD CONSTRAINT "sm_rows_score_ok"/.test(s)),
    planner.planned.some((s) => /CREATE INDEX "sm_rows_name_idx"/.test(s)),
  ], [true, true, true, true]);
  eq("effects are listed, not run", [effectRan, planner.planned.some((s) => /effects of sm_rows would run here: never/.test(s))], [false, true]);

  /* BotChat: "Setting the default of labels.color…" sat right above the plan:
     lines, in the present tense, in a run that changed nothing. */
  logs.length = 0;
  const withDefault = { ...v1, columns: { ...v1.columns, score: { type: "INTEGER", notNull: true, default: "5" } } };
  await new SchemaBuilder(db, DataSource.dialect, { dryRun: true, mode: "mirror" }).syncSchema("sm_rows", Entity.create("sm_rows", withDefault).schema);
  eq("dry run: the change appears as a plan line", said(/plan: ALTER TABLE "sm_rows" ALTER COLUMN "score" SET DEFAULT 5/), true);
  eq("dry run: no line narrates it as done", logs.filter((l) => /Setting the default|Dropping|Recreating|Adding a unique|validated|\] ran:/.test(l)), []);
  logs.length = 0;
  /* By here mirror has dropped legacy; `name` is the NOT NULL column to leave out. */
  const { name: _omit, ...withoutName } = v2.columns;
  await new SchemaBuilder(db, DataSource.dialect, { dryRun: true }).syncSchema("sm_rows", Entity.create("sm_rows", { columns: withoutName }).schema);
  eq("dry run, additive: the kept list is in the conditional", said(/sm_rows: would keep .*column name \(would be made nullable\)/), true);
  eq("…and nothing was loosened", (await one(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'sm_rows' AND column_name = 'name'`)).is_nullable, "NO");

  const fresh = new SchemaBuilder(db, DataSource.dialect, { dryRun: true });
  await fresh.syncSchema("sm_new", Entity.create("sm_new", { columns: { id: { type: "SERIAL", primaryKey: true } } }).schema);
  eq("a table that does not exist is planned, not created", [fresh.planned.some((s) => /^CREATE TABLE "sm_new"/.test(s)), (await one(`SELECT to_regclass('sm_new') IS NULL AS absent`)).absent], [true, true]);

  DataSource.driver(PgDriver({ connectionString: process.env.TEST_DATABASE_URL, sync: { dryRun: true } }));
  logs.length = 0;
  await DataSource.entities([Entity.create("sm_boot", { columns: { id: { type: "SERIAL", primaryKey: true } } })]).initialize();
  eq("initialize with dryRun says what it planned, and changes nothing", [said(/Dry run: \d+ statements? planned across 1 entity, nothing changed/), (await one(`SELECT to_regclass('sm_boot') IS NULL AS absent`)).absent], [true, true]);
}

section("renames in additive mode (LandingBuilder)");
{
  DataSource.driver(PgDriver({ connectionString: process.env.TEST_DATABASE_URL }));
  const person = (name) => Entity.create("sm_person", { columns: {
    id: { type: "SERIAL", primaryKey: true },
    fullName: { type: "TEXT", name },
  } });
  await createRepository(person("full_name")).syncSchema();
  await db.query(`INSERT INTO sm_person (full_name) VALUES ('Ada')`);
  await createRepository(person("display_name")).syncSchema();
  const p = (await db.query(`SELECT * FROM sm_person`)).rows[0];
  eq("without a snapshot: old column kept with its data, new one added empty", [p.full_name, p.display_name], ["Ada", null]);

  await db.query(`DROP TABLE sm_person`);
  DataSource.driver(PgDriver({ connectionString: process.env.TEST_DATABASE_URL, sync: { snapshot: true } }));
  await createRepository(person("full_name")).syncSchema();
  await db.query(`INSERT INTO sm_person (full_name) VALUES ('Ada')`);
  logs.length = 0;
  await createRepository(person("display_name")).syncSchema();
  const q = (await db.query(`SELECT * FROM sm_person`)).rows[0];
  eq("with a snapshot: the column is renamed and the data moves — additive mode or not", [q.display_name, "full_name" in q], ["Ada", false]);
  eq("…announced as it ran", said(/ran: ALTER TABLE "sm_person" RENAME COLUMN "full_name" TO "display_name"/), true);
}

await done();
