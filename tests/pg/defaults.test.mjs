import { orm, connect, section, eq, rejects, logs, said, done } from "./_harness.mjs";
const { DataSource, Entity, createRepository, SchemaBuilder } = orm;
void SchemaBuilder; void said;

const db = await connect();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
void one;
const nullable = async (t, c) => (await db.query(
  `SELECT is_nullable FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [t, c])).rows[0]?.is_nullable;
void nullable; void logs; void DataSource;
// throws(): the older scratchpad name for rejects()
const throws = (n, fn, re) => rejects(n, fn, re);
void throws;

/* Defaults of existing columns: compared by rendering, filled into NULL rows before NOT NULL; and the cascade-bypasses-hooks warning. */
const colDefault = async (t, c) => (await one(`SELECT column_default d FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [t, c]))?.d ?? null;
const attrdefOid = async (t, c) => (await one(
  `SELECT d.oid::int o FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE d.adrelid=$1::regclass AND a.attname=$2`, [t, c]))?.o ?? null;
/* ───── hướng 2, đúng ca sniprender ───── */
console.log("Hướng 2 · code bắt buộc + default random, trên cột đã có với hàng NULL");
await db.query(`CREATE TABLE hk_d2 (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  code text UNIQUE, kind text NOT NULL DEFAULT 'html', n SERIAL)`);
await db.query(`INSERT INTO hk_d2 (name) VALUES ('a'),('b'),('c'),('d')`);
await db.query(`INSERT INTO hk_d2 (name, code) VALUES ('e','deadbeef')`);

const cols = (over = {}) => ({
  id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
  name: { type: "TEXT", notNull: true },
  code: { type: "TEXT", notNull: true, unique: true, default: "left(gen_random_uuid()::text, 8)" },
  kind: { type: "TEXT", notNull: true, default: "'html'" },
  n: { type: "SERIAL" },
  ...over,
});
const kindOid0 = await attrdefOid("hk_d2", "kind");
const serial0 = await colDefault("hk_d2", "n");
logs.length = 0;
await createRepository(Entity.create("hk_d2", { columns: cols() })).syncSchema();
eq("boot qua, KHÔNG cần effect", true, true);
eq("default đã đặt lên cột có sẵn", await colDefault("hk_d2", "code"), `"left"((gen_random_uuid())::text, 8)`);
eq("4 hàng NULL được điền", (await one(`SELECT count(*)::int n FROM hk_d2 WHERE code IS NULL`)).n, 0);
eq("mỗi hàng một nhãn, hàng có sẵn giữ nguyên", [(await one(`SELECT count(DISTINCT code)::int n FROM hk_d2`)).n, (await one(`SELECT code FROM hk_d2 WHERE name='e'`)).code], [5, "deadbeef"]);
eq("nhãn đúng dạng 8 hex", (await one(`SELECT bool_and(code ~ '^[0-9a-f]{8}$') ok FROM hk_d2`)).ok, true);
eq("NOT NULL đã áp", await nullable("hk_d2", "code"), "NO");
eq("log nói rõ đã điền bao nhiêu hàng", said(/Filling 4 NULL rows of hk_d2\.code from its default/), true);
eq("'html' vs 'html'::text: không đặt lại (oid giữ)", await attrdefOid("hk_d2", "kind"), kindOid0);
eq("SERIAL: default nextval không bị đụng", await colDefault("hk_d2", "n"), serial0);

const codeOid = await attrdefOid("hk_d2", "code");
logs.length = 0;
await createRepository(Entity.create("hk_d2", { columns: cols() })).syncSchema();
eq("sync lần 2: default không bị đặt lại (oid giữ)", await attrdefOid("hk_d2", "code"), codeOid);
eq("sync lần 2: im lặng", logs.filter((l) => /default/i.test(l)), []);

await db.query(`INSERT INTO hk_d2 (name) VALUES ('raw-sql')`);
eq("SQL viết tay cũng có nhãn — database tự sinh", /^[0-9a-f]{8}$/.test((await one(`SELECT code FROM hk_d2 WHERE name='raw-sql'`)).code), true);
const viaRepo = await createRepository(Entity.create("hk_d2", { columns: cols() })).insert({ name: "repo", code: undefined });
eq("repository insert, code undefined → DEFAULT", /^[0-9a-f]{8}$/.test(viaRepo.code), true);

await createRepository(Entity.create("hk_d2", { columns: cols({ kind: { type: "TEXT", notNull: true, default: "'md'" } }) })).syncSchema();
eq("đổi default trong entity → đặt lại", await colDefault("hk_d2", "kind"), "'md'::text");
logs.length = 0;
await createRepository(Entity.create("hk_d2", { columns: cols({ kind: { type: "TEXT", notNull: true } }) })).syncSchema();
eq("bỏ default khỏi entity → DROP DEFAULT", await colDefault("hk_d2", "kind"), null);
eq("…và có nói ra", said(/Dropping the default of hk_d2\.kind/), true);

/* ───── thử lại khi trùng unique ───── */
section("Điền từ default trên cột unique: trùng thì thử lại");
await db.query(`CREATE SEQUENCE hk_rt_seq START 1; CREATE TABLE hk_rt (id serial PRIMARY KEY, code text UNIQUE)`);
await db.query(`INSERT INTO hk_rt (code) VALUES ('1'), (NULL)`);
const rt = (dflt) => Entity.create("hk_rt", { columns: {
  id: { type: "SERIAL", primaryKey: true },
  code: { type: "TEXT", notNull: true, unique: true, default: dflt },
} });
logs.length = 0;
await createRepository(rt("nextval('hk_rt_seq')::text")).syncSchema();
eq("lần 1 ra '1' đụng hàng có sẵn, lần 2 ra '2'", (await db.query(`SELECT code FROM hk_rt ORDER BY code`)).rows.map((r) => r.code), ["1", "2"]);
eq("log ghi lần thử lại", said(/collided on a unique value, retrying \(1\/5\)/), true);

await db.query(`ALTER TABLE hk_rt ALTER COLUMN code DROP NOT NULL; ALTER TABLE hk_rt ALTER COLUMN code DROP DEFAULT; INSERT INTO hk_rt (code) VALUES (NULL)`);
await rejects("default hằng số trên cột unique → hết lượt, lỗi nói thẳng",
  () => createRepository(rt("'1'")).syncSchema(), /hit a duplicate 5 times running — against a stored row, or between two values drawn/);
eq("…và cột chưa bị siết", await nullable("hk_rt", "code"), "YES");

/* ───── thông báo lỗi đã sửa ───── */
section("Thông báo khi không có default lẫn effect");
await db.query(`UPDATE hk_rt SET code = NULL WHERE code = '2'`);
await rejects("gợi ý default (giờ là đúng) và effect",
  () => createRepository(Entity.create("hk_rt", { columns: { id: { type: "SERIAL", primaryKey: true }, code: { type: "TEXT", notNull: true, unique: true } } })).syncSchema(),
  /2 existing rows hold NULL\. Declare a default on the column — sync fills NULL rows from it.*static effects/s);

/* ───── cascade đi vòng qua hook ───── */
section("Cascade: ORM không chặn được, nhưng nói ra");
const Parent = Entity.create("hk_parent", { columns: { id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" } } });
await createRepository(Parent).syncSchema();
const childCols = (action) => ({
  id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
  parentId: { type: "UUID", name: "parent_id", references: `hk_parent(id) ${action}` },
});
let removedByHook = 0;
class Child extends Entity.create("hk_child", { columns: childCols("ON DELETE CASCADE") }) {
  beforeRemove() { removedByHook++; }
}
logs.length = 0;
await createRepository(Child).syncSchema();
eq("khai beforeRemove + ON DELETE CASCADE → cảnh báo", said(/hk_child declares beforeRemove, but hk_child\.parent_id references .*ON DELETE CASCADE.*no hook sees them/), true);
logs.length = 0;
await createRepository(Entity.create("hk_child", { columns: childCols("ON DELETE CASCADE") })).syncSchema();
eq("không khai hook → im lặng", logs.filter((l) => /no hook sees/.test(l)), []);
class ChildU extends Entity.create("hk_child", { columns: childCols("ON DELETE SET NULL") }) { afterUpdate() {} }
logs.length = 0;
await createRepository(ChildU).syncSchema();
eq("khai afterUpdate + ON DELETE SET NULL → cảnh báo", said(/hk_child declares afterUpdate.*ON DELETE SET NULL/), true);

await createRepository(Child).syncSchema();
const par = await createRepository(Parent).insert({});
await createRepository(Child).insert({ parentId: par.id });
await createRepository(Parent).delete({ id: par.id });
eq("giới hạn là thật: hàng con bị cascade xoá", (await one(`SELECT count(*)::int n FROM hk_child`)).n, 0);
eq("…mà beforeRemove của nó không chạy", removedByHook, 0);


section("Literal defaults are compared without a temporary table");
{
  /* A dialect that counts probes and otherwise behaves like the real one. */
  const real = DataSource.dialect;
  let probes = 0;
  const counting = { ...real, renderDefaults: (...a) => { probes++; return real.renderDefaults(...a); } };
  await db.query(`CREATE TABLE hk_lit (id int PRIMARY KEY, kind text DEFAULT 'html', ccy text DEFAULT 'USD', at timestamptz DEFAULT now())`);
  const lit = Entity.create("hk_lit", { columns: {
    id: { type: "INTEGER", primaryKey: true },
    kind: { type: "TEXT", default: "'html'" },
    ccy: { type: "TEXT", default: "'USD'" },
    at: { type: "TIMESTAMPTZ", default: "now()" },
  } });
  await new SchemaBuilder(db, counting).syncSchema("hk_lit", lit.schema, lit);
  eq("'html'::text / 'USD'::text / now(): no probe at all", probes, 0);
  const fn = Entity.create("hk_lit", { columns: { ...lit.schema.columns, kind: { type: "TEXT", default: "lower('HTML')" } } });
  await new SchemaBuilder(db, counting).syncSchema("hk_lit", fn.schema, fn);
  const setOid = await attrdefOid("hk_lit", "kind");
  await new SchemaBuilder(db, counting).syncSchema("hk_lit", fn.schema, fn);
  /* Postgres stores lower('HTML') as lower('HTML'::text): the text never
     matches, so a function default is probed on every sync — and, the probe
     finding them equal, never set again. */
  eq("a function default is probed on each sync", probes, 2);
  eq("…and not set again once it matches", await attrdefOid("hk_lit", "kind"), setOid);
}

section("No TEMP privilege: defaults are left alone, boot goes on");
{
  const real = DataSource.dialect;
  const denied = { ...real, renderDefaults: async () => { const e = new Error("permission denied to create temporary tables"); e.code = "42501"; throw e; } };
  const fn2 = Entity.create("hk_lit", { columns: {
    id: { type: "INTEGER", primaryKey: true },
    kind: { type: "TEXT", default: "upper('md')" },
    ccy: { type: "TEXT", default: "'USD'" },
    at: { type: "TIMESTAMPTZ", default: "now()" },
  } });
  logs.length = 0;
  let threw = null;
  try { await new SchemaBuilder(db, denied).syncSchema("hk_lit", fn2.schema, fn2); } catch (e) { threw = e.message; }
  eq("sync does not throw", threw, null);
  eq("it says which defaults it could not compare", said(/Cannot compare the defaults of hk_lit \(kind\).*temporary tables/), true);
  eq("the default is left as it was", await colDefault("hk_lit", "kind"), "lower('HTML'::text)");
}

section("A probe on the builder's own transaction");
{
  const two = Entity.create("hk_lit", { columns: {
    id: { type: "INTEGER", primaryKey: true },
    kind: { type: "TEXT", default: "upper('md')" },
    ccy: { type: "TEXT", default: "'USD'" },
    at: { type: "TIMESTAMPTZ", default: "now()" },
  } });
  await DataSource.transaction(async (tx) => {
    const sb = new SchemaBuilder(tx);
    await sb.syncSchema("hk_lit", two.schema, two);
    // A second probe in the same session would collide with a fixed temp-table name.
    await sb.syncSchema("hk_lit", Entity.create("hk_lit", { columns: { ...two.schema.columns, kind: { type: "TEXT", default: "upper('x')" } } }).schema);
  });
  eq("two probes in one transaction, no name clash", await colDefault("hk_lit", "kind"), "upper('x'::text)");
}

section("Filling from a default over rows a NOT VALID check refuses");
{
  /* sniprender's production, had it gone the default route: projects_type_known
     NOT VALID over 'web' rows, and code about to be filled. Filling rewrites the
     whole row, so the check refuses a fill of a column it never mentions. */
  await db.query(`CREATE TABLE hk_nv (id serial PRIMARY KEY, type text NOT NULL, code text UNIQUE)`);
  await db.query(`INSERT INTO hk_nv (type) VALUES ('web'), ('html')`);
  await db.query(`ALTER TABLE hk_nv ADD CONSTRAINT hk_nv_type_known CHECK (type IN ('html')) NOT VALID`);
  await db.query(`COMMENT ON CONSTRAINT hk_nv_type_known ON hk_nv IS 'type IN (''html'')'`);
  const nvCols = {
    id: { type: "SERIAL", primaryKey: true },
    type: { type: "TEXT", notNull: true },
    code: { type: "TEXT", notNull: true, unique: true, default: "left(gen_random_uuid()::text, 8)" },
  };
  const NV = Entity.create("hk_nv", { columns: nvCols, checks: [{ name: "hk_nv_type_known", expression: "type IN ('html')" }] });
  await rejects("names the check and points at an effect, not a raw 23514",
    () => createRepository(NV).syncSchema(), /refused by check "hk_nv_type_known".*NOT VALID.*from an effect on the entity: effects run before this fill/s);
  class NVFixed extends Entity.create("hk_nv", { columns: nvCols, checks: [{ name: "hk_nv_type_known", expression: "type IN ('html')" }] }) {
    static effects = [{ name: "web", when: "sync", run: ({ tx }) => tx.query(`UPDATE hk_nv SET type = 'html' WHERE type = 'web'`) }];
  }
  await createRepository(NVFixed).syncSchema();
  eq("with the effect: rows fixed, filled, NOT NULL on, check validated", [
    (await one(`SELECT count(*)::int n FROM hk_nv WHERE code IS NULL`)).n,
    await nullable("hk_nv", "code"),
    (await one(`SELECT convalidated v FROM pg_constraint WHERE conname = 'hk_nv_type_known'`)).v,
  ], [0, "NO", true]);
}

section("Acknowledging a cascade silences its warning");
{
  class Ack extends Entity.create("hk_child", { columns: {
    id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
    parentId: { type: "UUID", name: "parent_id", references: "hk_parent(id) ON DELETE CASCADE", acknowledgeHookBypass: true },
  } }) { beforeRemove() {} }
  logs.length = 0;
  await createRepository(Ack).syncSchema();
  eq("acknowledgeHookBypass: true → no warning", logs.filter((l) => /no hook sees/.test(l)), []);
}

await done();
