/* Replacing a stored value — sniprender's production 500.

   An old server wrote type = 'web'; this one calls it 'html'. The check
   `type IN (…)` could only go on NOT VALID over those rows, and NOT VALID
   checks every UPDATE: any write to a legacy project failed with 23514.

   The mechanism is an effect. These cases pin down what it has to cover:
   the state production is in now, and a rename that narrows the check in the
   same deploy — where the effect runs while the OLD check is still in place. */
import { orm, connect, section, eq, rejects, logs, said, done } from "./_harness.mjs";
const { Entity, createRepository } = orm;

const db = await connect();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const validated = async (name) => (await one(`SELECT convalidated AS v FROM pg_constraint WHERE conname = $1`, [name]))?.v ?? null;
const types = async (t) => (await db.query(`SELECT type FROM ${t} ORDER BY type`)).rows.map((r) => r.type);

const cols = {
  id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
  type: { type: "TEXT", notNull: true },
  size: { type: "INTEGER", notNull: true, default: "0" },
};
const check = (list) => ({ name: "vr_type_known", expression: `type IN (${list.map((t) => `'${t}'`).join(", ")})` });

section("production today: the list dropped 'web' while 'web' rows remained");
{
  /* The history, replayed: the first list had 'web', rows were written with
     it, then the list moved on without it. */
  const First = Entity.create("vr_projects", { columns: cols, checks: [check(["web", "markdown", "react", "html"])] });
  await createRepository(First).syncSchema();
  await db.query(`INSERT INTO vr_projects (type) VALUES ('web'), ('web'), ('react')`);

  const Now = Entity.create("vr_projects", { columns: cols, checks: [check(["markdown", "react", "html", "react-sandbox"])] });
  logs.length = 0;
  await createRepository(Now).syncSchema();
  eq("reproduced: the new check could only go on NOT VALID", await validated("vr_type_known"), false);
  eq("the warning now says what that costs — UPDATEs to those rows fail",
    said(/vr_type_known on vr_projects is NOT VALID: 2 existing rows do not satisfy .*including any UPDATE to one of those rows, which fails with 23514/), true);
  await rejects("reproduced: a write to a legacy row fails — the 500",
    () => db.query(`UPDATE vr_projects SET size = size + 1 WHERE type = 'web'`), /violates check constraint/);

  class Fixed extends Entity.create("vr_projects", { columns: cols, checks: [check(["markdown", "react", "html", "react-sandbox"])] }) {
    static effects = [{
      name: "legacy-web-to-html",
      when: "sync",
      run: ({ tx }) => tx.query(`UPDATE vr_projects SET type = 'html' WHERE type = 'web'`),
    }];
  }
  logs.length = 0;
  await createRepository(Fixed).syncSchema();
  eq("the effect replaced the legacy values", await types("vr_projects"), ["html", "html", "react"]);
  eq("writes to those rows work again", (await db.query(`UPDATE vr_projects SET size = size + 1 WHERE type = 'html'`)).rowCount, 2);
  eq("the check is validated by sync, nobody has to run VALIDATE by hand", await validated("vr_type_known"), true);
  eq("…and it says so", said(/vr_type_known on vr_projects validated/), true);
  logs.length = 0;
  await createRepository(Fixed).syncSchema();
  eq("next boot: the effect finds nothing, sync is silent about the check", logs.filter((l) => /vr_type_known/.test(l)), []);
}

section("one deploy: rename AND narrow the check, new value not allowed by the old check");
{
  await db.query(`CREATE TABLE vr_two (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL, size integer NOT NULL DEFAULT 0)`);
  const Old = Entity.create("vr_two", { columns: cols, checks: [{ ...check(["web", "react"]), name: "vr_two_type_known" }] });
  await createRepository(Old).syncSchema();
  await db.query(`INSERT INTO vr_two (type) VALUES ('web'), ('react')`);

  class Next extends Entity.create("vr_two", { columns: cols, checks: [{ ...check(["react-sandbox", "react"]), name: "vr_two_type_known" }] }) {
    static effects = [{
      name: "web-to-sandbox",
      when: "once",
      run: ({ tx }) => tx.query(`UPDATE vr_two SET type = 'react-sandbox' WHERE type = 'web'`),
    }];
  }
  await createRepository(Next).syncSchema();
  eq("the effect could write a value only the NEW check allows", await types("vr_two"), ["react", "react-sandbox"]);
  eq("the new check went on validated, not NOT VALID", await validated("vr_two_type_known"), true);
  eq("the widened stand-in is gone", (await one(`SELECT count(*)::int n FROM pg_constraint WHERE conname LIKE 'vr_two_type_known_ecosy_%'`)).n, 0);
  await rejects("and it enforces the new list", () => db.query(`INSERT INTO vr_two (type) VALUES ('web')`), /violates check constraint/);
}

section("the effect fails: the table keeps a check, never none");
{
  await db.query(`CREATE TABLE vr_three (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL, size integer NOT NULL DEFAULT 0)`);
  const Old = Entity.create("vr_three", { columns: cols, checks: [{ ...check(["web", "react"]), name: "vr_three_known" }] });
  await createRepository(Old).syncSchema();
  await db.query(`INSERT INTO vr_three (type) VALUES ('web')`);
  class Broken extends Entity.create("vr_three", { columns: cols, checks: [{ ...check(["html", "react"]), name: "vr_three_known" }] }) {
    static effects = [{ name: "boom", when: "once", run: async () => { throw new Error("effect failed"); } }];
  }
  await rejects("sync fails with the effect's error", () => createRepository(Broken).syncSchema(), /effect failed/);
  await rejects("…and the table still refuses what neither list allows",
    () => db.query(`INSERT INTO vr_three (type) VALUES ('anything')`), /violates check constraint/);
}

await done();
