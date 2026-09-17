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
eq("…and the skip is counted in the log", said(/seed:plan_features: inserted 1 row into plan_features; 1 skipped, parent missing/), true);

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

await done();
