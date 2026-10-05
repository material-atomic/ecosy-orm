import { orm, connect, section, eq, rejects, done } from "./_harness.mjs";
const { DataSource, Entity, createRepository, observeQueries } = orm;

/* Every statement told to an observer: its SQL as sent, its params, its time, rows, error and the caller. */
const db = await connect();

section("observe · statements, params, rows, caller");
const seen = [];
const stop = observeQueries((q) => seen.push(q));

const T = Entity.create("obs_t", { columns: {
  id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
  name: { type: "TEXT", notNull: true },
} });
const t = createRepository(T);
await t.syncSchema();
seen.length = 0;

async function aCallerInThisFile() {
  return t.insert({ name: "observed" });
}
await aCallerInThisFile();
const insert = seen.find((q) => /^INSERT INTO/i.test(q.sql));
eq("an INSERT through a repository is seen", Boolean(insert), true);
eq("…with its parameters as sent", insert?.params.includes("observed"), true);
eq("…its rows", insert?.rowCount, 1);
eq("…a time", typeof insert?.ms === "number" && insert.ms >= 0, true);
eq("…on the pool", insert?.connection, "pool");
eq("…and the caller is this file, not the package", /observe\.test\.mjs/.test(insert?.caller ?? ""), true);
eq("…the stack starts with that caller", insert?.stack[0]?.includes("aCallerInThisFile"), true);

seen.length = 0;
await db.query("SELECT $1::int + 1 AS n", [41]);
eq("a raw query is seen with its SQL exactly as written", seen[0]?.sql, "SELECT $1::int + 1 AS n");
eq("…and its params", seen[0]?.params, [41]);

seen.length = 0;
await rejects("a failing statement still fails", () => db.query("SELECT * FROM obs_missing"), /does not exist/);
eq("…and is seen with the database's error code", seen[0]?.error?.code, "42P01");
eq("…and no rows", seen[0]?.rowCount, null);

seen.length = 0;
await DataSource.transaction(async (tx) => { await tx.query("SELECT 1"); });
eq("statements in a transaction are seen on a held connection", seen.some((q) => q.sql === "SELECT 1" && q.connection === "client"), true);

seen.length = 0;
const angry = observeQueries(() => { throw new Error("observer bug"); });
eq("an observer that throws never fails a query", (await db.query("SELECT 2 AS n")).rows[0].n, 2);
angry();

stop();
seen.length = 0;
await db.query("SELECT 3");
eq("stopping an observer stops it", seen.length, 0);

await done();
