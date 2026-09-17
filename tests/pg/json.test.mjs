/* JSON columns through the repository. Until 1.4.0 a string went to the column
   as raw text ("invalid input syntax for type json") and null as SQL NULL, which
   a NOT NULL column refuses where JSON null was meant. */
import { orm, connect, section, eq, rejects, done } from "./_harness.mjs";
const { Entity, createRepository } = orm;

const db = await connect();
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

const Features = Entity.create("js_features", {
  columns: {
    id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
    feature: { type: "TEXT", notNull: true },
    value: { type: "JSONB", notNull: true },
    note: { type: "JSONB" },
    raw: { type: "JSON" },
  },
});
const repo = createRepository(Features);
await repo.syncSchema();
const stored = async (feature) => one(
  `SELECT value, jsonb_typeof(value) AS t, note, note IS NULL AS note_sql_null FROM js_features WHERE feature = $1`, [feature],
);

section("insert: every JSON value, as the value it is");
await repo.insert([
  { feature: "string", value: "basic" },
  { feature: "null", value: null },
  { feature: "number", value: 3 },
  { feature: "boolean", value: false },
  { feature: "array", value: ["zip", "pdf"] },
  { feature: "object", value: { limit: 10 } },
  { feature: "json-looking string", value: '{"not":"parsed"}' },
]);
eq("a string is a JSON string", [(await stored("string")).value, (await stored("string")).t], ["basic", "string"]);
eq("null in a NOT NULL column is JSON null", [(await stored("null")).value, (await stored("null")).t], [null, "null"]);
eq("a number", (await stored("number")).t, "number");
eq("false is false, not missing", [(await stored("boolean")).value, (await stored("boolean")).t], [false, "boolean"]);
eq("an array", (await stored("array")).value, ["zip", "pdf"]);
eq("an object", (await stored("object")).value, { limit: 10 });
eq("a string that looks like JSON stays a string", [(await stored("json-looking string")).value, (await stored("json-looking string")).t], ['{"not":"parsed"}', "string"]);
eq("null in a nullable JSON column is SQL NULL", (await stored("string")).note_sql_null, true);

section("update and where");
await repo.update({ feature: "number" }, { value: null, note: "checked" });
const updated = await stored("number");
eq("update: null → JSON null, a string → JSON string", [updated.t, updated.note], ["null", "checked"]);
eq("where on a JSON string matches the row", (await repo.findOne({ where: { value: "basic" } }))?.feature, "string");
eq("where null on a nullable JSON column is IS NULL", (await repo.find({ where: { note: null } })).length, 6);
await repo.insert({ feature: "plain json", value: 1, raw: { a: [1, 2] } });
eq("a json (not jsonb) column takes a value too", (await one(`SELECT raw::text AS r FROM js_features WHERE feature = 'plain json'`)).r, '{"a":[1,2]}');

section("reads give the value back");
eq("the repository returns what was written", (await repo.find({ where: { feature: "array" } }))[0]?.value, ["zip", "pdf"]);
await rejects("a value JSON cannot hold is refused, by name, before the database", async () => {
  const cyclic = {}; cyclic.self = cyclic;
  await repo.insert({ feature: "cycle", value: cyclic });
}, /circular/i);

await done();
