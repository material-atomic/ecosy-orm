/* Soft delete, operation by operation, and the four places sniprender said it
   would snag: restoring only the children a parent took with it, a condition on
   the soft-delete column that would silently match nothing, live-only unique
   at index level, and telling soft from hard in the hooks. */
import { orm, connect, section, eq, rejects, logs, said, done } from "./_harness.mjs";
const { DataSource, Entity, createRepository, Between } = orm;

const db = await connect();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const idOf = async (t, name) => (await one(`SELECT id FROM ${t} WHERE name = $1`, [name])).id;
const names = (rows) => rows.map((r) => r.name).sort();

const uuid = { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" };
const deletedAt = { type: "TIMESTAMPTZ", name: "deleted_at" };

section("declaring it");
await rejects("softDelete must name a nullable timestamp column",
  () => Entity.create("sd_bad", { columns: { id: uuid, deletedAt: { ...deletedAt, notNull: true } }, softDelete: "deletedAt" }), /allows NULL/);
await rejects("…and a declared one",
  () => Entity.create("sd_bad", { columns: { id: uuid }, softDelete: "gone" }), /must name a declared TIMESTAMP/);
await rejects('unique: "live" needs softDelete',
  () => Entity.create("sd_bad", { columns: { id: uuid, email: { type: "TEXT", unique: "live" } } }), /no softDelete column/);

/* ───────── the lifecycle ───────── */
const log = [];
class Note extends Entity.create("sd_note", {
  columns: { id: uuid, name: { type: "TEXT", notNull: true }, deletedAt },
  softDelete: "deletedAt",
}) {
  beforeRemove({ soft }) { log.push(`beforeRemove:${this.name}:${soft}`); }
  afterRemove({ soft }) { log.push(`afterRemove:${this.name}:${soft}:${this.deletedAt ? "stamped" : "none"}`); }
  beforeRestore() { log.push(`beforeRestore:${this.name}:${this.deletedAt ? "still-deleted" : "?"}`); }
  afterRestore() { log.push(`afterRestore:${this.name}:${this.deletedAt === null ? "live" : "?"}`); }
}
const notes = createRepository(Note);
await notes.syncSchema();
await notes.insert([{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }]);

section("delete() is a soft delete");
log.length = 0;
await notes.delete({ name: "a" });
eq("the row is still in the table", (await one(`SELECT count(*)::int n FROM sd_note WHERE name = 'a'`)).n, 1);
eq("…stamped", (await one(`SELECT deleted_at IS NOT NULL AS s FROM sd_note WHERE name = 'a'`)).s, true);
eq("hooks run with soft: true", log, ["beforeRemove:a:true", "afterRemove:a:true:stamped"]);

section("find sees live rows unless told otherwise");
eq("find()", names(await notes.find({})), ["b", "c", "d"]);
eq("findOne on a deleted row → null", await notes.findOne({ where: { name: "a" } }), null);
eq("withDeleted", names(await notes.find({ withDeleted: true })), ["a", "b", "c", "d"]);
eq("onlyDeleted", names(await notes.find({ onlyDeleted: true })), ["a"]);
await rejects("both at once is refused", () => notes.find({ withDeleted: true, onlyDeleted: true }), /together mean nothing/);
eq("an OR condition is bracketed: a deleted row matching one arm stays out",
  names(await notes.find({ where: [{ name: "a" }, { name: "b" }] })), ["b"]);

section("a condition on deleted_at while only live rows are in scope");
await rejects("find → refused, not an empty result",
  () => notes.find({ where: { deletedAt: Between(["2000-01-01", "2100-01-01"]) } }), /only live rows are in scope/);
await rejects("hard delete → refused too: the purge that deletes nothing",
  () => notes.delete({ deletedAt: Between(["2000-01-01", "2100-01-01"]) }, { hard: true }), /onlyDeleted/);
eq("with onlyDeleted it is allowed",
  names(await notes.find({ where: { deletedAt: Between(["2000-01-01", "2100-01-01"]) }, onlyDeleted: true })), ["a"]);

section("update touches live rows only, and never the soft-delete column");
eq("update(where) skips the deleted row", (await notes.update([{ name: "a" }, { name: "b" }], { name: "x" })).rowCount, 1);
await notes.update({ name: "x" }, { name: "b" });
eq("withDeleted reaches it", (await notes.update({ name: "a" }, { name: "a" }, { withDeleted: true })).rowCount, 1);
await rejects("update setting deletedAt is refused", () => notes.update({ name: "b" }, { deletedAt: new Date().toISOString() }), /delete\(\) or restore\(\)/);
await rejects("a soft delete cannot reach deleted rows (it would re-stamp them)",
  () => notes.delete({ name: "a" }, { withDeleted: true }), /reaches live rows only/);

section("restore");
log.length = 0;
const back = await notes.restore({ name: "a" });
eq("restores the row", [back.rowCount, back.rows[0]?.name], [1, "a"]);
eq("beforeRestore sees it still deleted, afterRestore live", log, ["beforeRestore:a:still-deleted", "afterRestore:a:live"]);
eq("restore() on a live row does nothing", (await notes.restore({ name: "b" })).rowCount, 0);

section("hard delete");
log.length = 0;
await notes.delete({ name: "d" }, { hard: true });
eq("gone from the table", (await one(`SELECT count(*)::int n FROM sd_note WHERE name = 'd'`)).n, 0);
eq("hooks run with soft: false", log, ["beforeRemove:d:false", "afterRemove:d:false:none"]);
await notes.delete({ name: "c" });
const purged = await notes.delete({ deletedAt: Between(["2000-01-01", "2100-01-01"]) }, { hard: true, onlyDeleted: true });
eq("purge: hard + onlyDeleted removes exactly the deleted rows", [purged.rowCount, names(await notes.find({ withDeleted: true }))], [1, ["a", "b"]]);

section("the entity instance");
const b = await notes.findOne({ where: { name: "b" } });
b.name = "b2"; await b.save();
eq("save() does not write deletedAt, and saves", (await notes.findOne({ where: { name: "b2" } }))?.deletedAt, null);
await b.delete();
eq("instance.delete() soft-deletes", (await notes.find({ onlyDeleted: true })).map((r) => r.name), ["b2"]);
await b.restore();
eq("instance.restore() brings it back, and the instance with it", [b.deletedAt, (await notes.find({})).length], [null, 2]);
await rejects("restore() on an entity without softDelete is refused",
  () => createRepository(Entity.create("sd_plain", { columns: { id: uuid } })).restore({}), /no softDelete column/);

/* ───────── sniprender 1: restore only what went with the parent ───────── */
section("parent and children share one stamp; restoring brings back only those");
class File extends Entity.create("sd_file", {
  columns: {
    id: uuid, name: { type: "TEXT", notNull: true },
    projectId: { type: "UUID", name: "project_id", notNull: true },
    path: { type: "TEXT", notNull: true }, deletedAt,
  },
  indexes: [{ name: "sd_file_path_live", columns: ["projectId", "path"], unique: "live" }],
  softDelete: "deletedAt",
}) {}
const files = createRepository(File);
class Project extends Entity.create("sd_project", {
  columns: { id: uuid, name: { type: "TEXT", notNull: true }, deletedAt },
  softDelete: "deletedAt",
}) {
  async afterRemove({ db, soft }) {
    if (soft) await files.using(db).delete({ projectId: this.id });
  }
  async beforeRestore({ db }) {
    await files.using(db).restore({ projectId: this.id, deletedAt: this.deletedAt });
  }
}
const projects = createRepository(Project);
await projects.syncSchema();
await files.syncSchema();
const p = await projects.insert({ name: "P" });
await files.insert([
  { name: "A", projectId: p.id, path: "a.txt" },
  { name: "B", projectId: p.id, path: "b.txt" },
  { name: "C", projectId: p.id, path: "index.html" },
]);
await files.delete({ name: "A" });                      // Monday
await new Promise((r) => setTimeout(r, 15));
await projects.delete({ id: p.id });                     // Tuesday
const stamps = (await db.query(`SELECT name, deleted_at::text AS t FROM sd_file ORDER BY name`)).rows;
const parentStamp = (await one(`SELECT deleted_at::text AS t FROM sd_project`)).t;
eq("the children the parent took carry the parent's exact stamp", stamps.filter((r) => r.t === parentStamp).map((r) => r.name), ["B", "C"]);
eq("the file deleted the day before keeps its own", stamps.find((r) => r.name === "A").t !== parentStamp, true);
eq("stamps are whole milliseconds — they survive a trip through a JS Date",
  (await one(`SELECT bool_and(deleted_at = date_trunc('milliseconds', deleted_at)) AS ok FROM sd_file WHERE deleted_at IS NOT NULL`)).ok, true);
await projects.restore({ id: p.id });
eq("restoring P brings back B and C, not A", names(await files.find({})), ["B", "C"]);

section("a stamp read into JavaScript and passed back matches itself");
{
  await notes.insert({ name: "rt" });
  await notes.delete({ name: "rt" });
  const [row] = await notes.find({ where: { name: "rt" }, onlyDeleted: true });
  eq("deletedAt reads back as a Date", row.deletedAt instanceof Date, true);
  eq("restore({ deletedAt: <that Date> }) finds the row", (await notes.restore({ name: "rt", deletedAt: row.deletedAt })).rowCount, 1);

  /* The control: the same trip with a microsecond stamp — what now() gives
     untruncated — does not match. This is the bug the truncation prevents. */
  await notes.delete({ name: "rt" });
  await db.query(`UPDATE sd_note SET deleted_at = '2026-09-11 10:00:00.123456+00' WHERE name = 'rt'`);
  const [micro] = await notes.find({ where: { name: "rt" }, onlyDeleted: true });
  eq("control: a microsecond stamp does not survive the trip", (await notes.restore({ name: "rt", deletedAt: micro.deletedAt })).rowCount, 0);
  await notes.delete({ name: "rt" }, { hard: true, onlyDeleted: true });
}

/* ───────── sniprender 3: live-only unique at index level ───────── */
section('unique: "live" on an index — (project_id, path)');
await files.delete({ name: "C" });
await files.insert({ name: "C2", projectId: p.id, path: "index.html" });
eq("index.html can be created again once the old one is deleted", names(await files.find({})), ["B", "C2"]);
await rejects("restoring the old one collides → clear error, nothing restored",
  () => files.restore({ name: "C" }), /would duplicate a value a live row holds.*Nothing was restored/);
eq("…C is still deleted", (await files.find({ onlyDeleted: true, where: { name: "C" } })).length, 1);
await rejects("the whole restore is all or nothing",
  () => files.restore([{ name: "A" }, { name: "C" }]), /Nothing was restored/);
eq("…A did not come back either", (await files.find({ where: { name: "A" } })).length, 0);

/* ───────── unique: true vs "live" on a column ───────── */
section('unique: true counts deleted rows; unique: "live" does not');
const userCols = (unique) => ({ id: uuid, name: { type: "TEXT", notNull: true }, email: { type: "TEXT", unique }, deletedAt });
const Code = Entity.create("sd_code", { columns: userCols(true), softDelete: "deletedAt" });
const codes = createRepository(Code);
await codes.syncSchema();
await codes.insert({ name: "old", email: "abcd1234" });
await codes.delete({ name: "old" });
await rejects("true: a deleted row's value is not given up (a shared link stays its owner's)",
  () => codes.insert({ name: "new", email: "abcd1234" }), /duplicate key|unique/i);

section("upsert against a soft-deleted row: refused, never revived");
await codes.insert({ name: "live-one", email: "live0001" });
await rejects("upsert colliding with a deleted row throws, with the way out",
  () => codes.upsert([{ name: "revived?", email: "abcd1234" }, { name: "fresh", email: "fresh001" }], ["email"]),
  /collide on \(email\) with soft-deleted rows.*does not revive.*restore\(\) it and then update\(\).*Nothing was written/s);
eq("…the deleted row stayed deleted and untouched", (await db.query(`SELECT name, deleted_at IS NOT NULL AS gone FROM sd_code WHERE email = 'abcd1234'`)).rows, [{ name: "old", gone: true }]);
eq("…and the rest of the batch was rolled back", (await db.query(`SELECT count(*)::int n FROM sd_code WHERE email = 'fresh001'`)).rows[0].n, 0);
const liveUp = await codes.upsert({ name: "live-one-b", email: "live0001" }, ["email"]);
eq("upsert against a live row still updates it", liveUp.name, "live-one-b");

const liveUser = Entity.create("sd_user", { columns: userCols("live"), softDelete: "deletedAt" });
const users = createRepository(liveUser);
await users.syncSchema();
await users.insert({ name: "u1", email: "x@y.z" });
await users.delete({ name: "u1" });
await users.insert({ name: "u2", email: "x@y.z" });
eq('"live": re-registration with a deleted account\'s email works', names(await users.find({})), ["u2"]);
const up = await users.upsert({ name: "u2b", email: "x@y.z" }, ["email"]);
eq("upsert on a live column targets the partial index (ON CONFLICT … WHERE)", [up.name, (await users.find({})).length], ["u2b", 1]);
await rejects("restoring u1 collides with u2 → named, nothing restored", () => users.restore({ name: "u1" }), /x@y\.z/);

section("sync: switching a column between true and \"live\"");
const constraintOn = async (t, c) => (await one(
  `SELECT count(*)::int n FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.conrelid = $1::regclass AND c.contype = 'u' AND a.attname = $2`, [t, c])).n;
const indexDef = async (name) => (await one(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [name]))?.indexdef ?? null;
const indexOid = async (name) => (await one(`SELECT to_regclass($1)::oid::int AS o`, [name])).o;

const S1 = Entity.create("sd_switch", { columns: userCols(true), softDelete: "deletedAt" });
await createRepository(S1).syncSchema();
eq("true → a constraint", await constraintOn("sd_switch", "email"), 1);
const S2 = Entity.create("sd_switch", { columns: userCols("live"), softDelete: "deletedAt" });
await createRepository(S2).syncSchema();
eq('"live" → the constraint is dropped', await constraintOn("sd_switch", "email"), 0);
eq("…and a partial unique index built", /UNIQUE INDEX .* WHERE \(deleted_at IS NULL\)/.test(await indexDef("sd_switch_email_live_key")), true);
const liveOid = await indexOid("sd_switch_email_live_key");
logs.length = 0;
await createRepository(S2).syncSchema();
eq("next sync keeps the index (not dropped as undeclared, not rebuilt)", await indexOid("sd_switch_email_live_key"), liveOid);
eq("…silently", logs.filter((l) => /index|unique/i.test(l)), []);
await createRepository(S1).syncSchema();
eq('back to true → index gone, constraint back', [await indexDef("sd_switch_email_live_key"), await constraintOn("sd_switch", "email")], [null, 1]);

await db.query(`INSERT INTO sd_switch (name, email) VALUES ('p', 'dup'), ('q', NULL)`);
const S3 = Entity.create("sd_switch", { columns: { ...userCols(true), name: { type: "TEXT", notNull: true, unique: true } }, softDelete: "deletedAt" });
await db.query(`INSERT INTO sd_switch (name) VALUES ('p')`);
await rejects("adding unique over duplicates → names them, before Postgres does",
  () => createRepository(S3).syncSchema(), /declared unique, but existing rows repeat values — for example "p"/);

void DataSource; void said;
await done();
