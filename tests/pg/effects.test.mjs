import { orm, connect, section, eq, rejects, logs, said, done } from "./_harness.mjs";
const { DataSource, Entity, createRepository, SchemaBuilder } = orm;
void SchemaBuilder; void said;

/* Tests removal too, which only "mirror" does. */
const db = await connect({ mode: "mirror" });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
void one;
const nullable = async (t, c) => (await db.query(
  `SELECT is_nullable FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [t, c])).rows[0]?.is_nullable;
void nullable; void logs; void DataSource;
// throws(): the older scratchpad name for rejects()
const throws = (n, fn, re) => rejects(n, fn, re);
void throws;

/* Effects: the loosen → effects → tighten order sync runs, "sync" vs "once", rollback, and concurrency. */
/* ───────── C. đúng ca sniprender ───────── */
section("C · ca sniprender: code thành bắt buộc trên hàng cũ đang NULL");
const snCols = (codeNotNull) => ({
  id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
  name: { type: "TEXT", notNull: true },
  fullname: { type: "TEXT" },
  code: { type: "TEXT", unique: true, notNull: codeNotNull },
});
await createRepository(Entity.create("hk_sn", { columns: snCols(false) })).syncSchema();
await db.query(`INSERT INTO hk_sn (name, fullname) VALUES ('a','Ada Lovelace'),('b','Alan Turing'),('c','Grace Hopper')`);

await throws("notNull, KHÔNG effect → lỗi nói rõ 3 hàng NULL và cách sửa",
  () => createRepository(Entity.create("hk_sn", { columns: snCols(true) })).syncSchema(), /3 existing rows hold NULL.*effect/s);
eq("…và cột vẫn nullable, không nửa vời", await nullable("hk_sn", "code"), "YES");

let syncRuns = 0;
class SN extends Entity.create("hk_sn", { columns: snCols(true) }) {
  static effects = [{
    name: "backfill-code", when: "sync",
    run: async ({ tx }) => { syncRuns++; await tx.query(`UPDATE hk_sn SET code = left(gen_random_uuid()::text, 8) WHERE code IS NULL`); },
  }];
}
await createRepository(SN).syncSchema();
eq("có effect: boot qua", true, true);
eq("không còn hàng NULL", (await db.query(`SELECT count(*)::int n FROM hk_sn WHERE code IS NULL`)).rows[0].n, 0);
eq("mỗi hàng một code (volatile tính theo hàng)", (await db.query(`SELECT count(DISTINCT code)::int n FROM hk_sn`)).rows[0].n, 3);
eq("NOT NULL đã áp", await nullable("hk_sn", "code"), "NO");
await createRepository(SN).syncSchema();
eq("effect 'sync' chạy mỗi lần sync", syncRuns, 2);

/* ───────── D. cột notNull mới, không default, trên bảng có dữ liệu + once ───────── */
section("D · thêm cột bắt buộc lên bảng có dữ liệu, điền bằng effect 'once'");
let onceRuns = 0;
const snD = { ...snCols(true), slug: { type: "TEXT", notNull: true } };
class SND extends Entity.create("hk_sn", { columns: snD }) {
  static effects = [{
    name: "fill-slug", when: "once",
    run: async ({ repository, tx }) => {
      onceRuns++;
      for (const row of await repository.find({ where: { slug: null } })) {
        await repository.update({ id: row.id }, { slug: `p-${row.name}` });
      }
    },
  }];
}
await createRepository(SND).syncSchema();
eq("slug điền qua repository trong transaction", (await db.query(`SELECT string_agg(slug, ',' ORDER BY slug) s FROM hk_sn`)).rows[0].s, "p-a,p-b,p-c");
eq("slug NOT NULL đã áp", await nullable("hk_sn", "slug"), "NO");
await createRepository(SND).syncSchema();
eq("'once' không chạy lại", onceRuns, 1);
eq("bản ghi theo dõi", (await db.query(`SELECT name FROM _ecosy_effects WHERE entity='hk_sn'`)).rows.map(r => r.name), ["fill-slug"]);

/* ───────── E. once hỏng → rollback, không ghi bản ghi ───────── */
section("E · 'once' hỏng giữa chừng");
class SNE extends Entity.create("hk_sn", { columns: snD }) {
  static effects = [{ name: "half", when: "once", run: async ({ tx }) => {
    await tx.query(`UPDATE hk_sn SET name = 'CHANGED'`); throw new Error("boom");
  } }];
}
await throws("sync ném, lỗi của effect", () => createRepository(SNE).syncSchema(), /boom/);
eq("dữ liệu đã đổi bị rollback", (await db.query(`SELECT count(*)::int n FROM hk_sn WHERE name='CHANGED'`)).rows[0].n, 0);
eq("không có bản ghi → lần sau chạy lại", (await db.query(`SELECT count(*)::int n FROM _ecosy_effects WHERE name='half'`)).rows[0].n, 0);

/* ───────── F. đọc cột sắp bị drop trong cùng lần sync ───────── */
section("F · di chuyển dữ liệu trước khi cột cũ bị drop");
const { fullname, ...withoutFull } = snD;
class SNF extends Entity.create("hk_sn", { columns: { ...withoutFull, first: { type: "TEXT" } } }) {
  static effects = [{ name: "split-fullname", when: "once",
    run: ({ tx }) => tx.query(`UPDATE hk_sn SET first = split_part(fullname, ' ', 1)`) }];
}
await createRepository(SNF).syncSchema();
eq("first lấy từ fullname", (await db.query(`SELECT string_agg(first, ',' ORDER BY first) s FROM hk_sn`)).rows[0].s, "Ada,Alan,Grace");
eq("fullname đã bị drop SAU effect", await nullable("hk_sn", "fullname"), undefined);

/* ───────── G. ba tiến trình boot cùng lúc ───────── */
section("G · ba lần sync đồng thời, một effect 'once'");
const ccCols = { id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" } };
await createRepository(Entity.create("hk_cc", { columns: ccCols })).syncSchema();
await db.query(`CREATE TABLE hk_cc_log (at timestamptz default now())`);
class CC extends Entity.create("hk_cc", { columns: ccCols }) {
  static effects = [{ name: "count-me", when: "once", run: async ({ tx }) => {
    await tx.query(`SELECT pg_sleep(0.2)`); await tx.query(`INSERT INTO hk_cc_log DEFAULT VALUES`);
  } }];
}
const results = await Promise.allSettled([1, 2, 3].map(() => new SchemaBuilder(db).syncSchema("hk_cc", CC.schema, CC)));
eq("không lần nào hỏng", results.filter(r => r.status === "rejected").length, 0);
eq("effect chạy đúng một lần", (await db.query(`SELECT count(*)::int n FROM hk_cc_log`)).rows[0].n, 1);

/* ───────── H. đường initialize ───────── */
section("H · DataSource.initialize cũng chạy effect");
let initRuns = 0;
class INI extends Entity.create("hk_cc", { columns: ccCols }) {
  static effects = [{ name: "init", when: "sync", run: () => { initRuns++; } }];
}
await DataSource.entities([INI]).initialize();
eq("initialize → effect chạy", initRuns, 1);


await done();
