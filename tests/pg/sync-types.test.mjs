/* What 1.3.0 added to the core, none of it about vectors: types `data_type`
   cannot name, column transformers, index method / operator class / storage
   parameters, and extensions the driver installs. Churn is caught by the log
   for columns — a retype says `ran: ALTER … TYPE` — and by the oid for indexes,
   which a rebuilt index does not keep. */
import { orm, PgDriver, connect, section, eq, rejects, logs, said, done } from "./_harness.mjs";
const { DataSource, Entity, createRepository, SchemaBuilder } = orm;

const url = process.env.TEST_DATABASE_URL;
const db = await connect({ mode: "mirror" });
const retyped = (table) => logs.some((line) => new RegExp(`ran: ALTER TABLE "${table}" ALTER COLUMN .* TYPE`).test(line));
const oid = async (name) => (await db.query(`SELECT oid::int AS oid FROM pg_class WHERE relname = $1`, [name])).rows[0]?.oid ?? null;
const sync = (EntityClass) => createRepository(EntityClass).syncSchema();

section("an enum and arrays are not retyped on every boot");
await db.query(`CREATE TYPE st_mood AS ENUM ('ok', 'bad')`);
const Typed = (tags) => Entity.create("st_typed", { columns: {
  id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
  mood: { type: "st_mood" },
  tags: { type: tags },
  counts: { type: "INT[]" },
  stamps: { type: "timestamptz[]" },
  labels: { type: "varchar(20)[]" },
} });
await sync(Typed("TEXT[]"));
logs.length = 0;
await sync(Typed("TEXT[]"));
await sync(Typed("TEXT[]"));
eq("two more boots: no column retyped (enum, text[], INT[], timestamptz[], varchar(20)[])", retyped("st_typed"), false);
logs.length = 0;
await sync(Typed("VARCHAR(40)[]"));
eq("a real change still retypes: text[] → varchar(40)[]", retyped("st_typed"), true);
logs.length = 0;
await sync(Typed("VARCHAR(40)[]"));
eq("…and the boot after leaves it", retyped("st_typed"), false);

section("a column transformer: `to` on writes and where, `from` on reads, neither for null");
const calls = { to: 0, from: 0 };
const csv = {
  to: (list) => { calls.to++; return list.join(","); },
  from: (text) => { calls.from++; return text.split(","); },
};
const Tagged = Entity.create("st_tagged", { columns: {
  id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
  tags: { type: "TEXT", transformer: csv },
  note: { type: "TEXT" },
} });
const tagged = createRepository(Tagged);
await tagged.syncSchema();
const row = await tagged.insert({ tags: ["a", "b"], note: "x" });
eq("stored as `to` wrote it", (await db.query(`SELECT tags FROM st_tagged`)).rows[0].tags, "a,b");
eq("the inserted row comes back through `from`", row.tags, ["a", "b"]);
eq("an equality where goes through `to`", (await tagged.findOne({ where: { tags: ["a", "b"] } }))?.note, "x");
await tagged.update({ id: row.id }, { tags: ["c"] });
eq("an update goes through `to`", (await tagged.findOne({ where: { id: row.id } }))?.tags, ["c"]);
const before = { ...calls };
await tagged.insert({ tags: null, note: "empty" });
const empty = await tagged.findOne({ where: { note: "empty" } });
eq("null reaches neither", [empty?.tags, calls.to - before.to, calls.from - before.from], [null, 0, 0]);

section("index method, operator class and storage parameters");
const Docs = (index) => Entity.create("st_docs", {
  columns: {
    id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
    data: { type: "JSONB" },
  },
  indexes: [{ name: "st_docs_data_idx", columns: ["data"], ...index }],
});
const definition = async () => (await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'st_docs_data_idx'`)).rows[0]?.indexdef ?? "";

await sync(Docs({ using: "gin", opclass: "jsonb_path_ops", with: { fastupdate: false } }));
eq("created with its method, class and parameters",
  /USING gin \(data jsonb_path_ops\) WITH \(fastupdate='?false'?\)/.test(await definition()), true);
const g1 = await oid("st_docs_data_idx");
await sync(Docs({ using: "gin", opclass: "jsonb_path_ops", with: { fastupdate: false } }));
eq("unchanged: not rebuilt", await oid("st_docs_data_idx"), g1);

await sync(Docs({ using: "gin", opclass: "jsonb_ops", with: { fastupdate: false } }));
const g2 = await oid("st_docs_data_idx");
eq("another operator class: rebuilt", g2 !== g1, true);
await sync(Docs({ using: "gin", opclass: "jsonb_ops", with: { fastupdate: false } }));
eq("a DEFAULT class declared by name — left out of the definition — is not rebuilt every boot", await oid("st_docs_data_idx"), g2);

await sync(Docs({ using: "gin", opclass: "jsonb_ops", with: { fastupdate: true } }));
const g3 = await oid("st_docs_data_idx");
eq("a changed storage parameter: rebuilt", g3 !== g2, true);
await sync(Docs({ using: "gin", opclass: "jsonb_ops" }));
const g4 = await oid("st_docs_data_idx");
eq("a storage parameter no longer declared: rebuilt", g4 !== g3, true);
await sync(Docs({}));
const g5 = await oid("st_docs_data_idx");
eq("no method declared where a GIN stands: rebuilt as the default b-tree", [g5 !== g4, /USING btree/.test(await definition())], [true, true]);
await sync(Docs({}));
eq("…and the b-tree is left the boot after", await oid("st_docs_data_idx"), g5);
await rejects("a method that is not an identifier is refused before any SQL",
  () => sync(Docs({ using: "gin; DROP TABLE st_docs" })), /not a valid index method/);

section("extensions the driver lists are installed before any table");
const Emails = Entity.create("st_emails", { columns: {
  id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
  email: { type: "citext", unique: true },
} });
await DataSource.end();
await DataSource.initialize(PgDriver({ connectionString: url, extensions: ["citext"] }));
logs.length = 0;
await sync(Emails);
const created = logs.findIndex((line) => /ran: CREATE EXTENSION IF NOT EXISTS "citext"/.test(line));
const table = logs.findIndex((line) => /ran: CREATE TABLE "st_emails"/.test(line));
eq("the extension is created, then the table that needs it", created !== -1 && table > created, true);
await createRepository(Emails).insert({ email: "Ada@Example.com" });
eq("…and the type works: citext compares case-insensitively",
  (await db.query(`SELECT count(*)::int AS n FROM st_emails WHERE email = 'ada@example.com'`)).rows[0].n, 1);
logs.length = 0;
await sync(Emails);
eq("the next sync in the same process sends nothing for it", said(/EXTENSION/), false);

await DataSource.end();
await DataSource.initialize(PgDriver({ connectionString: url, extensions: ["citext"] }));
logs.length = 0;
await sync(Emails);
eq("a fresh process finds it installed and creates nothing", said(/CREATE EXTENSION/), false);

await DataSource.end();
await DataSource.initialize(PgDriver({ connectionString: url, extensions: ["pg_trgm"], sync: { dryRun: true } }));
const planner = new SchemaBuilder(new DataSource());
await planner.syncSchema("st_planned", { columns: { id: { type: "UUID", name: "id", primaryKey: true, notNull: true } } });
eq("a dry run plans the extension", planner.planned.some((sql) => /CREATE EXTENSION IF NOT EXISTS "pg_trgm"/.test(sql)), true);
eq("…and installs nothing", (await db.query(`SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_trgm'`)).rows[0].n, 0);

await DataSource.end();
await DataSource.initialize(PgDriver({ connectionString: url, extensions: ["ecosy_no_such_extension"] }));
await rejects("an extension that cannot be installed is named, with what to do about it",
  () => sync(Emails), /Could not create extension "ecosy_no_such_extension".*superuser or the database owner/s);

await done();
