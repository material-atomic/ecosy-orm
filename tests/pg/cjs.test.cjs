/* The CommonJS build: effects.js is loaded by a dynamic import inside
   query-builder, which is exactly the kind of path that has broken the CJS
   output of this package before. */
const path = require("node:path");
const dist = path.join(__dirname, "..", "..", "dist");
const { DataSource, Entity, createRepository } = require(path.join(dist, "index.js"));
const { PgDriver } = require(path.join(dist, "drivers", "pg.js"));

(async () => {
  DataSource.logger({ debug() {}, info() {}, warn() {}, error() {} });
  await DataSource.initialize(PgDriver({ connectionString: process.env.TEST_DATABASE_URL }));
  let ran = 0;
  class E extends Entity.create("hk_cjs", { columns: { id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" } } }) {}
  E.effects = [{ name: "x", when: "sync", run: () => { ran++; } }];
  await createRepository(E).syncSchema();
  await DataSource.end();
  console.log(`  ${ran === 1 ? "✓" : "✗"} the CJS build loads effects.js and runs an effect\n\n${ran === 1 ? 1 : 0} passed, ${ran === 1 ? 0 : 1} failed`);
  process.exit(ran === 1 ? 0 : 1);
})().catch((e) => { console.error("  ✗", e.message); process.exit(1); });
