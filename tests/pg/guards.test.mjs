/* Two ways sync could hang at boot — the worst way to fail, with no log and a
   container that runs and never becomes ready. Both must refuse at once. */
import { orm, PgDriver, connect, section, eq, rejects, done } from "./_harness.mjs";
const { DataSource, Entity, createRepository } = orm;
await connect();

const cols = { id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" } };

section("an effect that syncs its own entity");
{
  class Loop extends Entity.create("gd_loop", { columns: cols }) {
    static effects = [{ name: "resync", when: "sync", run: () => createRepository(Loop).syncSchema() }];
  }
  const started = Date.now();
  await rejects("refused immediately, not left waiting on its own lock",
    () => createRepository(Loop).syncSchema(), /called from inside the sync of gd_loop/);
  eq("…within a second", Date.now() - started < 1000, true);

  const Other = Entity.create("gd_other", { columns: cols });
  class Fine extends Entity.create("gd_fine", { columns: cols }) {
    static effects = [{ name: "sync-other", when: "sync", run: () => createRepository(Other).syncSchema() }];
  }
  await createRepository(Fine).syncSchema();
  eq("syncing a DIFFERENT entity from an effect is allowed", (await new DataSource().query(`SELECT to_regclass('gd_other') IS NOT NULL AS ok`)).rows[0].ok, true);

  const Same = Entity.create("gd_same", { columns: cols });
  const all = await Promise.allSettled([1, 2, 3].map(() => createRepository(Same).syncSchema()));
  eq("concurrent syncs of one entity are not mistaken for nesting", all.filter((r) => r.status === "rejected").length, 0);
}

section("a pool too small for what sync holds at once");
{
  /* The pool itself is shared and already open; what is checked is the size
     the installed driver was configured with. */
  DataSource.driver(PgDriver({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }));
  class WithEffect extends Entity.create("gd_pool", { columns: cols }) {
    static effects = [{ name: "x", when: "sync", run: () => {} }];
  }
  await rejects("max 2 with an effect → refused, naming the size needed",
    () => createRepository(WithEffect).syncSchema(), /holds up to 3 connections.*pool allows 2.*Raise `max` to 3/s);
  await createRepository(Entity.create("gd_pool2", { columns: cols })).syncSchema();
  eq("max 2 without effects is enough", (await new DataSource().query(`SELECT to_regclass('gd_pool2') IS NOT NULL AS ok`)).rows[0].ok, true);
  DataSource.driver(PgDriver({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }));
  await rejects("max 1 → refused even without effects",
    () => createRepository(Entity.create("gd_pool3", { columns: cols })).syncSchema(), /holds up to 2 connections.*pool allows 1/s);
}

await done();
