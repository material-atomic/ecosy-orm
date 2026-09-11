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

section("an effect that goes to the pool instead of its transaction");
{
  const db = new DataSource();
  await db.query(`CREATE TABLE gd_rows (id int PRIMARY KEY, v text)`);
  await db.query(`INSERT INTO gd_rows VALUES (1, 'a')`);
  const rowCols = { id: { type: "INTEGER", primaryKey: true }, v: { type: "TEXT" } };

  /* The hang this prevents: tx writes row 1, then a pool statement writes row 1
     and waits for tx's row lock — while tx waits for this effect to return. */
  class Deadlock extends Entity.create("gd_rows", { columns: rowCols }) {
    static effects = [{
      name: "pool-write", when: "sync",
      run: async ({ tx }) => {
        await tx.query(`UPDATE gd_rows SET v = 'tx' WHERE id = 1`);
        await new DataSource().query(`UPDATE gd_rows SET v = 'pool' WHERE id = 1`);
      },
    }];
  }
  const started = Date.now();
  await rejects("refused before it is sent, naming the effect and the fix",
    () => createRepository(Deadlock).syncSchema(), /reached the pool from inside effect gd_rows:pool-write.*Use the `tx` or the `repository`/s);
  eq("…at once, not after a wait", Date.now() - started < 2000, true);
  eq("…and the effect's own write rolled back with it", (await db.query(`SELECT v FROM gd_rows WHERE id = 1`)).rows[0].v, "a");

  class RepoOutside extends Entity.create("gd_rows", { columns: rowCols }) {
    static effects = [{ name: "unbound-repo", when: "sync", run: () => createRepository(RepoOutside).find({}) }];
  }
  await rejects("an unbound repository inside an effect is refused too",
    () => createRepository(RepoOutside).syncSchema(), /reached the pool from inside effect gd_rows:unbound-repo/);

  class NewTx extends Entity.create("gd_rows", { columns: rowCols }) {
    static effects = [{ name: "own-tx", when: "sync", run: () => DataSource.transaction(async () => {}) }];
  }
  await rejects("so is opening a second transaction", () => createRepository(NewTx).syncSchema(), /A new transaction reached the pool/);

  let afterCommitRan = false;
  class Bound extends Entity.create("gd_rows", { columns: rowCols }) {
    static effects = [{
      name: "bound", when: "sync",
      run: async ({ tx, repository }) => {
        await repository.update({ id: 1 }, { v: "via-repo" });
        await createRepository(Bound).using(tx).find({});
        tx.afterCommit(async () => { await new DataSource().query(`SELECT 1`); afterCommitRan = true; });
      },
    }];
  }
  await createRepository(Bound).syncSchema();
  eq("the given repository, and one bound with .using(tx), are fine", (await db.query(`SELECT v FROM gd_rows WHERE id = 1`)).rows[0].v, "via-repo");
  eq("an afterCommit callback, running after the effect, may use the pool", afterCommitRan, true);
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
