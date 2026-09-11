/* Foreign keys, checks and renames: reconciled without churn. The churn
   detector is the constraint's oid — a constraint dropped and recreated gets a
   new one, however identical it looks. */
import { orm, connect, section, eq, logs, said, done } from "./_harness.mjs";
const { Entity, SchemaBuilder } = orm;

const db = await connect();
const sb = new SchemaBuilder(db);

section("foreign keys");
const parent = Entity.create("t_parent", { columns: { id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" } } });
const child = (refs) => Entity.create("t_child", { columns: {
  id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
  parentId: refs ? { type: "UUID", name: "parent_id", references: refs } : { type: "UUID", name: "parent_id" },
} });
const fk = async () => (await db.query(
  `SELECT oid::int AS oid, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 't_child'::regclass AND contype = 'f'`,
)).rows[0] ?? null;
const step = async (refs) => { await sb.syncSchema("t_parent", parent.schema); await sb.syncSchema("t_child", child(refs).schema); return fk(); };

const a = await step("t_parent(id)");
const b = await step("t_parent(id)");
const c = await step("t_parent(id) ON DELETE CASCADE");
const d = await step("t_parent(id) ON DELETE CASCADE");
const e = await step(null);
eq("unchanged key is not recreated", b.oid, a.oid);
eq("ON DELETE CASCADE is applied", /ON DELETE CASCADE/.test(c.def), true);
eq("a real change recreates it", c.oid !== b.oid, true);
eq("…and the next sync leaves it (0a416be)", d.oid, c.oid);
eq("removed references → key dropped", e, null);

section("checks");
const msg = (fmt) => Entity.create("chk_msg", {
  columns: {
    id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
    format: { type: "TEXT", notNull: true },
    text: { type: "TEXT", notNull: true },
    author: { type: "TEXT" },
  },
  checks: [
    { name: "chk_msg_format", expression: fmt },
    { name: "chk_msg_len", expression: "char_length(text) BETWEEN 1 AND 8192" },
    { name: "chk_msg_author", expression: "author IS NULL OR char_length(author) > 0" },
  ],
});
const oids = async () => Object.fromEntries((await db.query(
  `SELECT conname, oid::int AS oid FROM pg_constraint WHERE conrelid = 'chk_msg'::regclass AND contype = 'c'`,
)).rows.map((r) => [r.conname, r.oid]));

const IN3 = "format IN ('text','html','markdown')";
await sb.syncSchema("chk_msg", msg(IN3).schema);
const c1 = await oids();
await sb.syncSchema("chk_msg", msg(IN3).schema);
const c2 = await oids();
eq("IN and BETWEEN checks are not recreated on the second sync", c2, c1);
await sb.syncSchema("chk_msg", msg("format IN ('text','html')").schema);
const c3 = await oids();
eq("a changed expression recreates that check", c3.chk_msg_format !== c2.chk_msg_format, true);
eq("…and only that one", [c3.chk_msg_len, c3.chk_msg_author], [c2.chk_msg_len, c2.chk_msg_author]);
await db.query(`COMMENT ON CONSTRAINT "chk_msg_len" ON "chk_msg" IS NULL`);
await sb.syncSchema("chk_msg", msg("format IN ('text','html')").schema);
const c4 = await oids();
await sb.syncSchema("chk_msg", msg("format IN ('text','html')").schema);
const c5 = await oids();
eq("a check with no recorded declaration is recreated once", c4.chk_msg_len !== c3.chk_msg_len, true);
eq("…and then left alone", c5.chk_msg_len, c4.chk_msg_len);

section("rename without a snapshot");
const v1 = Entity.create("rn_demo", { columns: { id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" }, fullName: { type: "TEXT", name: "full_name" } } });
const v2 = Entity.create("rn_demo", { columns: { id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" }, displayName: { type: "TEXT", name: "display_name" } } });
await sb.syncSchema("rn_demo", v1.schema);
await db.query(`INSERT INTO rn_demo (full_name) VALUES ('Cảnh')`);
logs.length = 0;
await sb.syncSchema("rn_demo", v2.schema);
eq("a drop alongside an add warns that it may be a rename", said(/If that is a rename/), true);

await done();
