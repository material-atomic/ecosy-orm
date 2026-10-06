import pg from "pg";
import { connect, section, eq, logs, done } from "./_harness.mjs";

/* The server dropping an idle connection must not take the process with it. */
const db = await connect();

section("pool · an idle connection the server drops");
await db.query("SELECT 1");

/* Another session ends every connection of this database but its own, as a restart or an admin would. */
const killer = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
await killer.connect();
const { rows } = await killer.query(
  "SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
);
await killer.end();
eq("the pool's idle connection was ended by the server", rows[0].n >= 1, true);

/* The pool hears of it on its next turn of the event loop; an unheard 'error' would have exited here. */
await new Promise((resolve) => setTimeout(resolve, 200));
eq("the process is still here, and says what happened", logs.some((line) => /idle connection was lost/.test(line)), true);

const after = await db.query("SELECT 41 + 1 AS n");
eq("the next query opens a new connection and answers", after.rows[0].n, 42);

await done();
