import { orm, connect, section, eq, rejects, logs, said, done } from "./_harness.mjs";
const { DataSource, Entity, createRepository, SchemaBuilder } = orm;
void SchemaBuilder; void said;

const db = await connect();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const count = async (sql, p = []) => (await db.query(sql, p)).rows[0].n;
void one;
const nullable = async (t, c) => (await db.query(
  `SELECT is_nullable FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [t, c])).rows[0]?.is_nullable;
void nullable; void logs; void DataSource;
// throws(): the older scratchpad name for rejects()
const throws = (n, fn, re) => rejects(n, fn, re);
void throws;

/* Writes: undefined is "not written", and all six lifecycle hooks — atomic with the write they belong to. */
/* ───────── A. undefined không còn thành NULL ───────── */
section("A · undefined");
const A = Entity.create("hk_a", { columns: {
  id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
  name: { type: "TEXT", notNull: true },
  code: { type: "TEXT" },
  currency: { type: "TEXT", notNull: true, default: "'USD'" },
} });
const a = createRepository(A);
await a.syncSchema();
const r1 = await a.insert({ name: "x", code: undefined, currency: undefined });
eq("insert: currency undefined → DEFAULT 'USD'", r1.currency, "USD");
await a.update({ id: r1.id }, { code: "abc" });
await a.update({ id: r1.id }, { code: undefined, name: "y" });
const r1b = await a.findOne({ where: { id: r1.id } });
eq("update { code: undefined } giữ nguyên code", r1b.code, "abc");
eq("…và vẫn ghi field có giá trị", r1b.name, "y");
const none = await a.update({ id: r1.id }, { code: undefined });
eq("update không còn gì để ghi → 0 hàng, không lỗi", none.rowCount, 0);
const two = await a.insert([{ name: "m", currency: "VND" }, { name: "n" }]);
eq("insert nhiều hàng lệch hình → ô thiếu là DEFAULT", two.map(r => r.currency), ["VND", "USD"]);
await throws("upsert lệch hình → từ chối, không ghi đè bằng default",
  () => a.upsert([{ id: r1.id, name: "p", code: "z" }, { id: two[0].id, name: "q" }], ["id"]), /others do/);

/* ───────── B. hook vòng đời ───────── */
section("B · hook vòng đời");
class P extends Entity.create("hk_p", { columns: {
  id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
  name: { type: "TEXT", notNull: true },
  code: { type: "TEXT", notNull: true, unique: true },
  updatedAt: { type: "TIMESTAMPTZ", name: "updated_at", notNull: true, default: "now()" },
} }) {
  beforeInsert() { this.code ??= crypto.randomUUID().slice(0, 8); }
  async beforeUpdate() { await new Promise(r => setTimeout(r, 5)); this.updatedAt = new Date().toISOString(); }
  afterLoad() { this.label = `${this.name}#${this.code}`; }
}
const p = createRepository(P);
await p.syncSchema();
const p1 = await p.insert({ name: "one" });
eq("beforeInsert điền code", /^[0-9a-f]{8}$/.test(p1.code), true);
eq("không ghi đè code đã truyền", (await p.insert({ name: "two", code: "given001" })).code, "given001");
const batch = await p.insert([{ name: "b1" }, { name: "b2" }, { name: "b3" }]);
eq("insert nhiều hàng: mỗi hàng một code riêng", new Set(batch.map(r => r.code)).size, 3);
eq("afterLoad chạy trên hàng insert trả về", p1.label, `one#${p1.code}`);
const up = await p.upsert({ name: "u1", code: "upsert01" }, ["code"]);
eq("upsert chạy beforeInsert (có code sẵn thì giữ)", up.code, "upsert01");

const before = (await p.findOne({ where: { id: p1.id } })).updatedAt;
await new Promise(r => setTimeout(r, 20));
await p.update({ id: p1.id }, { name: "one*" });
const after = await p.findOne({ where: { id: p1.id } });
eq("beforeUpdate (async) đặt lại updatedAt trên update()", new Date(after.updatedAt) > new Date(before), true);
eq("afterLoad chạy trên find", after.label, `one*#${p1.code}`);
await new Promise(r => setTimeout(r, 20));
const t0 = after.updatedAt;
after.name = "one**";
await after.save();
const saved = await p.findOne({ where: { id: p1.id } });
eq("save() cũng qua beforeUpdate", new Date(saved.updatedAt) > new Date(t0), true);
eq("…và instance mang giá trị hook đã đặt", after.updatedAt, saved.updatedAt);
eq("label (không phải cột) không lọt vào SQL", saved.name, "one**");

class Bad extends Entity.create("hk_p", { columns: P.schema.columns }) { async afterLoad() {} }
await throws("afterLoad async → ném, không để promise trôi", () => createRepository(Bad).find({}), /synchronous/);


{
await db.query(`DROP TABLE IF EXISTS hk_six, hk_audit`);
await db.query(`CREATE TABLE hk_audit (op text, row_id uuid, name text)`);

const log = [];
let fail = null;   // tên hook sẽ ném
const cols = {
  id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
  name: { type: "TEXT", notNull: true },
  code: { type: "TEXT", notNull: true },
  updatedAt: { type: "TIMESTAMPTZ", name: "updated_at", notNull: true, default: "now()" },
};
class Six extends Entity.create("hk_six", { columns: cols }) {
  beforeInsert() { this.code ??= crypto.randomUUID().slice(0, 8); }
  async afterInsert({ db }) {
    log.push(["afterInsert", this.name, typeof this.id]);
    await db.query(`INSERT INTO hk_audit VALUES ('insert', $1, $2)`, [this.id, this.name]);
    if (fail === "afterInsert") throw new Error("afterInsert boom");
  }
  beforeUpdate() { this.updatedAt = new Date(Date.now() + 1000).toISOString(); }
  async afterUpdate({ db }) {
    log.push(["afterUpdate", this.name, this.code]);
    await db.query(`INSERT INTO hk_audit VALUES ('update', $1, $2)`, [this.id, this.name]);
    if (fail === "afterUpdate") throw new Error("afterUpdate boom");
  }
  beforeRemove() {
    log.push(["beforeRemove", this.name, this.code]);
    if (this.name === "protected") throw new Error("refused: protected");
  }
  async afterRemove({ db }) {
    log.push(["afterRemove", this.name]);
    await db.query(`INSERT INTO hk_audit VALUES ('remove', $1, $2)`, [this.id, this.name]);
    if (fail === "afterRemove") throw new Error("afterRemove boom");
  }
}
const six = createRepository(Six);
await six.syncSchema();
const reset = async () => { log.length = 0; fail = null; };

console.log("afterInsert");
await reset();
const ins = await six.insert([{ name: "a" }, { name: "b" }, { name: "c" }]);
eq("chạy mỗi hàng, `this` có id đã sinh", log, [["afterInsert","a","string"],["afterInsert","b","string"],["afterInsert","c","string"]]);
eq("ghi qua db nằm cùng transaction", await count(`SELECT count(*)::int n FROM hk_audit WHERE op='insert'`), 3);
await reset(); fail = "afterInsert";
await rejects("afterInsert ném → insert ném", () => six.insert({ name: "ghost" }), /afterInsert boom/);
eq("…và hàng bị rollback", await count(`SELECT count(*)::int n FROM hk_six WHERE name='ghost'`), 0);
eq("…cùng bản audit của nó", await count(`SELECT count(*)::int n FROM hk_audit WHERE name='ghost'`), 0);

section("afterUpdate");
await reset();
const up = await six.update([{ name: "a" }, { name: "b" }], { code: "shared01" });
eq("update theo WHERE: mỗi hàng đổi một lần, `this` là hàng đầy đủ", log.map(l => l.join(":")).sort(), ["afterUpdate:a:shared01", "afterUpdate:b:shared01"]);
eq("rows trả về là entity đã đổi", up.rows.map(r => r.code), ["shared01", "shared01"]);
eq("rowCount", up.rowCount, 2);
await reset(); fail = "afterUpdate";
await rejects("afterUpdate ném → update ném", () => six.update({ name: "c" }, { code: "nope0000" }), /afterUpdate boom/);
eq("…và thay đổi bị rollback", (await six.findOne({ where: { name: "c" } })).code !== "nope0000", true);

section("save() đọc lại hàng");
await reset();
const c = await six.findOne({ where: { name: "c" } });
const beforeTs = c.updatedAt;
c.name = "c2"; await c.save();
eq("giá trị beforeUpdate đặt có mặt trên chính instance", new Date(c.updatedAt) > new Date(beforeTs), true);
eq("save() cũng qua afterUpdate", log.map(l => l[0]), ["afterUpdate"]);

section("beforeRemove / afterRemove");
await six.insert({ name: "protected" });
await reset();
await rejects("beforeRemove ném → không xoá gì", () => six.delete([{ name: "a" }, { name: "protected" }]), /refused/);
eq("…cả hàng đã được hook duyệt cũng còn", await count(`SELECT count(*)::int n FROM hk_six WHERE name IN ('a','protected')`), 2);
await reset();
const del = await six.delete([{ name: "a" }, { name: "b" }]);
eq("beforeRemove thấy hàng đầy đủ, mỗi hàng một lần", log.filter(l => l[0] === "beforeRemove").map(l => l.join(":")).sort(), ["beforeRemove:a:shared01", "beforeRemove:b:shared01"]);
eq("afterRemove mỗi hàng đã xoá", log.filter(l => l[0] === "afterRemove").length, 2);
eq("rows trả về là hàng đã xoá", del.rows.map(r => r.name).sort(), ["a", "b"]);
eq("đã xoá thật", await count(`SELECT count(*)::int n FROM hk_six WHERE name IN ('a','b')`), 0);
await reset(); fail = "afterRemove";
await rejects("afterRemove ném → delete ném", () => six.delete({ name: "c2" }), /afterRemove boom/);
eq("…và hàng quay lại", await count(`SELECT count(*)::int n FROM hk_six WHERE name='c2'`), 1);
await reset();
eq("delete không khớp hàng nào → 0, không gọi hook", [(await six.delete({ name: "zzz" })).rowCount, log.length], [0, 0]);
await reset();
const one = await six.findOne({ where: { name: "c2" } });
await one.delete();
eq("instance.delete() cũng qua hai hook", log.map(l => l[0]), ["beforeRemove", "afterRemove"]);

section("hook dùng transaction của người gọi");
await reset();
await rejects("người gọi rollback", () => DataSource.transaction(async (tx) => {
  await six.using(tx).insert({ name: "in-tx" });
  throw new Error("caller aborts");
}), /caller aborts/);
eq("hàng không còn", await count(`SELECT count(*)::int n FROM hk_six WHERE name='in-tx'`), 0);
eq("bản audit afterInsert ghi qua db cũng không còn", await count(`SELECT count(*)::int n FROM hk_audit WHERE name='in-tx'`), 0);
eq("(hook có chạy)", log.length, 1);

section("entity không hook: không đổi hành vi");
const Plain = Entity.create("hk_six", { columns: cols });
const plain = createRepository(Plain);
const pu = await plain.update({ name: "protected" }, { code: "plain001" });
eq("update trả rowCount, rows rỗng (không RETURNING)", [pu.rowCount, pu.rows.length], [1, 0]);
const pr = await plain.update({ name: "protected" }, { code: "plain002" }, { returning: true });
eq("returning: true → rows là entity", pr.rows[0].code, "plain002");


}

await done();
