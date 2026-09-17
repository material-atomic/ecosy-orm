/* Seeder, against the seeds RunSnip writes by hand today: plans (missing rows
   by id), plan_features (by (planId, feature), JSONB values where null means
   "no limit", a parent that may be gone) and admins (only while empty). */
import { orm, connect, section, eq, rejects, logs, said, done } from "./_harness.mjs";
const { Entity, Seeder, createRepository } = orm;

const db = await connect();
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;

const planSchema = {
  columns: {
    id: { type: "TEXT", primaryKey: true, notNull: true },
    name: { type: "TEXT", notNull: true },
    available: { type: "BOOLEAN", notNull: true, default: "false" },
    position: { type: "INTEGER", notNull: true, default: "0" },
  },
};
const featureSchema = {
  columns: {
    id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
    planId: { type: "TEXT", name: "plan_id", notNull: true, references: "plans(id) ON DELETE CASCADE" },
    feature: { type: "TEXT", notNull: true },
    value: { type: "JSONB", notNull: true },
  },
  indexes: [{ name: "sd_features_plan_feature_idx", columns: ["planId", "feature"], unique: true }],
};

let PLANS = [
  { id: "free", name: "Free", features: { projects: 3 } },
  { id: "pro", name: "Pro", features: { projects: null } },
];

class Plans extends Entity.create("plans", planSchema) {
  static effects = [Seeder(Plans, () => PLANS.map(({ features, ...plan }) => plan))];
}

section("missing (default): inserts what is not there, never changes what is");
await createRepository(Plans).syncSchema();
eq("both plans inserted", (await all(`SELECT id, name FROM plans ORDER BY id`)).map((r) => `${r.id}:${r.name}`), ["free:Free", "pro:Pro"]);
eq("column defaults applied to fields the seed leaves out", (await one(`SELECT available, position FROM plans WHERE id = 'free'`)), { available: false, position: 0 });

await db.query(`UPDATE plans SET name = 'Free (sửa bởi admin)' WHERE id = 'free'`);
PLANS = [...PLANS, { id: "team", name: "Team", features: { projects: 50 } }];
logs.length = 0;
await createRepository(Plans).syncSchema();
eq("an admin's edit survives the next sync", (await one(`SELECT name FROM plans WHERE id = 'free'`)).name, "Free (sửa bởi admin)");
eq("a row added to the seed reaches the existing database", (await one(`SELECT name FROM plans WHERE id = 'team'`))?.name, "Team");
eq("…and the log says how many", said(/seed:plans: inserted 1 row into plans/), true);

logs.length = 0;
await createRepository(Plans).syncSchema();
eq("a sync with nothing missing inserts nothing", said(/seed:plans: inserted/), false);

section("JSONB: null means JSON null in a NOT NULL column, and strings are JSON strings");
let FEATURES = [
  { planId: "free", feature: "projects", value: 3 },
  { planId: "pro", feature: "projects", value: null },
  { planId: "pro", feature: "tier", value: "basic" },
  { planId: "pro", feature: "exports", value: ["zip", "pdf"] },
  { planId: "team", feature: "sso", value: true },
];
class Features extends Entity.create("plan_features", featureSchema) {
  static effects = [Seeder(Features, () => FEATURES, { key: ["planId", "feature"] })];
}
await createRepository(Features).syncSchema();
const stored = Object.fromEntries((await all(`SELECT plan_id, feature, value, jsonb_typeof(value) AS t FROM plan_features`)).map((r) => [`${r.plan_id}/${r.feature}`, [r.value, r.t]]));
eq("null → JSON null (the column is NOT NULL)", stored["pro/projects"], [null, "null"]);
eq("a string → a JSON string", stored["pro/tier"], ["basic", "string"]);
eq("a number, an array, a boolean", [stored["free/projects"], stored["pro/exports"], stored["team/sso"]], [[3, "number"], [["zip", "pdf"], "array"], [true, "boolean"]]);

section("a row whose parent is gone is skipped, not a foreign-key failure");
FEATURES = [...FEATURES, { planId: "legacy", feature: "projects", value: 1 }, { planId: "team", feature: "seats", value: 10 }];
logs.length = 0;
await createRepository(Features).syncSchema();
eq("the row for the missing plan is not there", (await one(`SELECT count(*)::int AS n FROM plan_features WHERE plan_id = 'legacy'`)).n, 0);
eq("the rest of the batch still goes in", (await one(`SELECT value FROM plan_features WHERE plan_id = 'team' AND feature = 'seats'`))?.value, 10);
eq("…and the skip is logged, naming the row", said(/seed:plan_features: skipped 1 row whose parent is missing — row \d+: planId = legacy has no plans\(id\)/), true);

section("mistakes stop the sync, and name themselves");
class Typo extends Entity.create("plans", planSchema) {
  static effects = [Seeder(Typo, () => [{ id: "x", name: "X", avaliable: true }])];
}
await rejects("a property that is not a column", () => createRepository(Typo).syncSchema(), /row 0 has "avaliable", which is not a column of plans/);
eq("…and the effect rolled back", (await one(`SELECT count(*)::int AS n FROM plans WHERE id = 'x'`)).n, 0);

class Twice extends Entity.create("plans", planSchema) {
  static effects = [Seeder(Twice, [{ id: "dup", name: "A" }, { id: "dup", name: "B" }])];
}
await rejects("two seed rows with the same key", () => createRepository(Twice).syncSchema(), /two rows share the key \(dup\)/);

class NoKey extends Entity.create("plan_features", featureSchema) {
  static effects = [Seeder(NoKey, [{ planId: "free", value: 1 }], { key: ["planId", "feature"] })];
}
await rejects("a row with no value for a key column", () => createRepository(NoKey).syncSchema(), /row 0 has no value for key "feature"/);

let declared = "";
try {
  Seeder(Entity.create("plan_features", featureSchema), [], { key: ["feature"] });
} catch (error) {
  declared = error.message;
}
eq("a key no unique index guarantees is refused at declaration", /key \(feature\) is not guaranteed unique/.test(declared), true);

section("empty: only while the table has no row");
const adminSchema = {
  columns: {
    id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
    email: { type: "TEXT", unique: true, notNull: true },
  },
};
let EMAILS = ["an@example.com", "binh@example.com"];
class Admins extends Entity.create("admins", adminSchema) {
  static effects = [Seeder(Admins, () => EMAILS.map((email) => ({ email })), { mode: "empty", name: "seed-first-admins" })];
  beforeInsert() {
    this.email = this.email.trim().toLowerCase();
  }
}
EMAILS = ["  AN@Example.com ", "binh@example.com"];
await createRepository(Admins).syncSchema();
eq("seeded into the empty table, through beforeInsert", (await all(`SELECT email FROM admins ORDER BY email`)).map((r) => r.email), ["an@example.com", "binh@example.com"]);

await db.query(`DELETE FROM admins WHERE email = 'binh@example.com'`);
EMAILS = ["an@example.com", "binh@example.com", "chi@example.com"];
await createRepository(Admins).syncSchema();
eq("with rows present nothing is inserted — not even what the seed has that the table lacks",
  (await all(`SELECT email FROM admins ORDER BY email`)).map((r) => r.email), ["an@example.com"]);

section("once, under a stable name");
let onceRows = [{ id: "once-a", name: "A" }];
class Once extends Entity.create("plans", planSchema) {
  static effects = [Seeder(Once, () => onceRows, { when: "once", name: "seed-plans-once" })];
}
await createRepository(Once).syncSchema();
await db.query(`DELETE FROM plans WHERE id = 'once-a'`);
onceRows = [{ id: "once-a", name: "A" }, { id: "once-b", name: "B" }];
await createRepository(Once).syncSchema();
eq("a once seed does not run again, so a deleted row stays deleted", (await all(`SELECT id FROM plans WHERE id LIKE 'once-%'`)).length, 0);
eq("it is recorded under the name given", (await one(`SELECT count(*)::int AS n FROM _ecosy_effects WHERE entity = 'plans' AND name = 'seed-plans-once'`)).n, 1);

section("a soft-deleted row counts as present");
const softSchema = {
  columns: {
    id: { type: "TEXT", primaryKey: true, notNull: true },
    label: { type: "TEXT" },
    deletedAt: { type: "TIMESTAMPTZ", name: "deleted_at" },
  },
  softDelete: "deletedAt",
};
class Tags extends Entity.create("sd_tags", softSchema) {
  static effects = [Seeder(Tags, [{ id: "a", label: "A" }, { id: "b", label: "B" }])];
}
const tags = createRepository(Tags);
await tags.syncSchema();
await tags.delete({ id: "a" });
await tags.syncSchema();
eq("the soft-deleted row is not brought back, nor inserted twice",
  (await all(`SELECT id, deleted_at IS NOT NULL AS deleted FROM sd_tags ORDER BY id`)).map((r) => `${r.id}:${r.deleted}`), ["a:true", "b:false"]);

section("A1: an upper-case UUID key — equal to the lower-case one the table stores");
const UPPER = "0F8E4A6C-2B1D-4C3E-9A7B-5D6E7F8A9B0C";
class Accounts extends Entity.create("sd_accounts", {
  columns: { id: { type: "UUID", primaryKey: true, notNull: true }, label: { type: "TEXT" } },
}) {
  static effects = [Seeder(Accounts, [{ id: UPPER, label: "hệ thống" }])];
}
await createRepository(Accounts).syncSchema();
await rejects("boot 2 does not insert it again", async () => { await createRepository(Accounts).syncSchema(); throw new Error("booted"); }, /^booted$/);
eq("…and the table holds it once", (await one(`SELECT count(*)::int AS n FROM sd_accounts`)).n, 1);

class CaseTwice extends Entity.create("sd_accounts", {
  columns: { id: { type: "UUID", primaryKey: true, notNull: true }, label: { type: "TEXT" } },
}) {
  static effects = [Seeder(CaseTwice, [{ id: "11111111-1111-4111-8111-11111111111A" }, { id: "11111111-1111-4111-8111-11111111111a" }], { name: "seed-case-twice" })];
}
await rejects("two seed keys that differ only in case are one key", () => createRepository(CaseTwice).syncSchema(), /two rows share the key .* rows 0 and 1, equal as the database compares them/);

section("A2: a key column with a transformer — looked up as it is written");
const upper = { to: (v) => String(v).toUpperCase(), from: (v) => String(v).toLowerCase() };
class Codes extends Entity.create("sd_codes", {
  columns: {
    id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
    code: { type: "TEXT", unique: true, notNull: true, transformer: upper },
  },
}) {
  static effects = [Seeder(Codes, [{ code: "abc" }, { code: "xyz" }], { key: ["code"] })];
}
await createRepository(Codes).syncSchema();
await rejects("boot 2 finds both rows", async () => { await createRepository(Codes).syncSchema(); throw new Error("booted"); }, /^booted$/);
eq("…stored through the transformer, once each", (await all(`SELECT code FROM sd_codes ORDER BY code`)).map((r) => r.code), ["ABC", "XYZ"]);

section("a foreign key written in upper case still finds its parent");
const PARENT = "22222222-2222-4222-8222-22222222222b";
class Owners extends Entity.create("sd_owners", { columns: { id: { type: "UUID", primaryKey: true, notNull: true } } }) {
  static effects = [Seeder(Owners, [{ id: PARENT }])];
}
class Pets extends Entity.create("sd_pets", {
  columns: {
    id: { type: "TEXT", primaryKey: true, notNull: true },
    ownerId: { type: "UUID", name: "owner_id", references: "sd_owners(id)" },
  },
}) {
  static effects = [Seeder(Pets, [{ id: "rex", ownerId: PARENT.toUpperCase() }])];
}
await createRepository(Owners).syncSchema();
await createRepository(Pets).syncSchema();
eq("the child is inserted, not skipped as parentless", (await one(`SELECT owner_id FROM sd_pets WHERE id = 'rex'`))?.owner_id, PARENT);

section("B: a table that refers to itself — parents from the same seed, whatever their order");
const warns = [];
orm.DataSource.logger({ debug() {}, info: (m) => logs.push(String(m)), warn: (m) => { warns.push(String(m)); logs.push(String(m)); }, error: (m) => logs.push(String(m)) });
const tree = [
  { id: "leaf", parentId: "branch" },
  { id: "orphan", parentId: "nowhere" },
  { id: "under-orphan", parentId: "orphan" },
  { id: "cycle-a", parentId: "cycle-b" },
  { id: "cycle-b", parentId: "cycle-a" },
  { id: "self", parentId: "self" },
  ...Array.from({ length: 600 }, (_, i) => ({ id: `filler-${i}`, parentId: null })),
  { id: "branch", parentId: "root" },
  { id: "root", parentId: null },
];
class Categories extends Entity.create("sd_categories", {
  columns: {
    id: { type: "TEXT", primaryKey: true, notNull: true },
    parentId: { type: "TEXT", name: "parent_id", references: "sd_categories(id)" },
  },
}) {
  static effects = [Seeder(Categories, tree, { when: "once", name: "seed-categories" })];
}
await createRepository(Categories).syncSchema();
eq("children listed before their parents, a parent past the first chunk: all in, in one boot",
  (await all(`SELECT id FROM sd_categories WHERE id IN ('root','branch','leaf') ORDER BY id`)).map((r) => r.id), ["branch", "leaf", "root"]);
eq("the fillers too", (await one(`SELECT count(*)::int AS n FROM sd_categories WHERE id LIKE 'filler-%'`)).n, 600);
eq("a row pointing at nothing is left out", (await one(`SELECT count(*)::int AS n FROM sd_categories WHERE id = 'orphan'`)).n, 0);
const warning = warns.find((m) => /seed-categories: skipped 4 rows/.test(m)) ?? "";
eq("a row pointing at itself goes in — Postgres checks the key at the end of the statement", (await one(`SELECT parent_id FROM sd_categories WHERE id = 'self'`))?.parent_id, "self");
eq("rows pointing at each other in a cycle are left out", (await one(`SELECT count(*)::int AS n FROM sd_categories WHERE id LIKE 'cycle-%'`)).n, 0);
eq("the warning: a parent that is nowhere", /row 1: parentId = nowhere points at no row in sd_categories or in this seed/.test(warning), true);
eq("the warning: a parent in this seed that was itself skipped", /row 2: parentId = orphan points at row 1 of this seed, which was itself skipped/.test(warning), true);
eq("the warning: a cycle, with its rows", /row 3: parentId = cycle-b is part of a reference cycle, rows 3 → 4 → 3/.test(warning), true);

section("a parent skipped for another table's key is still named as in this seed");
const nodeWarns = [];
orm.DataSource.logger({ debug() {}, info: (m) => logs.push(String(m)), warn: (m) => { nodeWarns.push(String(m)); logs.push(String(m)); }, error: (m) => logs.push(String(m)) });
class Nodes extends Entity.create("sd_nodes", {
  columns: {
    id: { type: "TEXT", primaryKey: true, notNull: true },
    parentId: { type: "TEXT", name: "parent_id", references: "sd_nodes(id)" },
    ownerId: { type: "UUID", name: "owner_id", references: "sd_owners(id)" },
  },
}) {
  static effects = [Seeder(Nodes, [
    { id: "child", parentId: "parent" },
    { id: "parent", ownerId: "33333333-3333-4333-8333-333333333333" },
  ])];
}
await createRepository(Nodes).syncSchema();
const nodeWarning = nodeWarns.find((m) => /seed:sd_nodes: skipped 2 rows/.test(m)) ?? "";
eq("the parent: its owner is missing", /row 1: ownerId = 33333333-3333-4333-8333-333333333333 has no sd_owners\(id\)/.test(nodeWarning), true);
eq("the child: its parent is in this seed and was skipped", /row 0: parentId = parent points at row 1 of this seed, which was itself skipped/.test(nodeWarning), true);

await done();
