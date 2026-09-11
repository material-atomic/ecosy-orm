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

/* afterCommit: after COMMIT, never after ROLLBACK, errors logged not thrown, and the caller's commit when bound with using(tx). */
await db.query(`DROP TABLE IF EXISTS hk_ac`);
const cols = { id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" }, name: { type: "TEXT", notNull: true } };
const seen = [];
class AC extends Entity.create("hk_ac", { columns: cols }) {
  afterInsert({ afterCommit }) {
    seen.push(`hook:${this.name}`);
    afterCommit(async () => {
      /* Đọc qua POOL, tức một kết nối khác: chỉ thấy hàng nếu đã commit thật. */
      const r = await db.query(`SELECT count(*)::int n FROM hk_ac WHERE name = $1`, [this.name]);
      seen.push(`commit:${this.name}:${r.rows[0].n}`);
    });
  }
}
const ac = createRepository(AC);
await ac.syncSchema();

console.log("tx.afterCommit");
let ran = [];
await DataSource.transaction(async (tx) => {
  tx.afterCommit(() => ran.push("a"));
  tx.afterCommit(() => ran.push("b"));
  eq("chưa chạy khi transaction còn mở", ran, []);
});
eq("chạy sau commit, đúng thứ tự đăng ký; transaction() chờ chúng xong", ran, ["a", "b"]);

ran = [];
await DataSource.transaction(async (tx) => { tx.afterCommit(() => ran.push("x")); throw new Error("abort"); }).catch(() => {});
eq("rollback → bỏ callback", ran, []);

ran = []; logs.length = 0;
const out = await DataSource.transaction(async (tx) => {
  tx.afterCommit(() => { throw new Error("mail server down"); });
  tx.afterCommit(() => ran.push("sau-lỗi"));
  return "ok";
});
eq("callback ném: người gọi KHÔNG thấy lỗi", out, "ok");
eq("…lỗi được log", logs.some((e) => /afterCommit callback failed.*committed/.test(e)), true);
eq("…callback sau vẫn chạy", ran, ["sau-lỗi"]);

const tx = await DataSource.transaction();
await tx.commit();
let threw = false;
try { tx.afterCommit(() => {}); } catch (e) { threw = /was committed/.test(e.message); }
eq("đăng ký trên transaction đã xong → ném", threw, true);

section("afterCommit từ hook");
seen.length = 0;
await ac.insert({ name: "solo" });
eq("hook tự mở transaction: callback thấy hàng đã commit", seen, ["hook:solo", "commit:solo:1"]);

seen.length = 0;
let during = null;
await DataSource.transaction(async (tx) => {
  await ac.using(tx).insert({ name: "nested" });
  during = [...seen];
  await tx.query(`SELECT 1`);
});
eq("using(tx): lúc repository trả về, callback CHƯA chạy", during, ["hook:nested"]);
eq("…chạy khi NGƯỜI GỌI commit, và thấy hàng", seen, ["hook:nested", "commit:nested:1"]);

seen.length = 0;
await DataSource.transaction(async (tx) => {
  await ac.using(tx).insert({ name: "doomed" });
  throw new Error("caller aborts");
}).catch(() => {});
eq("người gọi rollback → callback của hook bị bỏ", seen, ["hook:doomed"]);


await done();
