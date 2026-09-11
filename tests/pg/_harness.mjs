/**
 * Shared by every *.test.mjs: the built package, a connection, and the
 * smallest assertion kit that prints what it checked.
 *
 * A file exits non-zero when any check fails; the runner counts exit codes.
 */
const dist = new URL("../../dist/", import.meta.url);

export const orm = await import(new URL("index.mjs", dist).href);
export const { PgDriver } = await import(new URL("drivers/pg.mjs", dist).href);
export const loadMigration = () => import(new URL("migration.mjs", dist).href);
export const fixtures = new URL("./fixtures/", import.meta.url).pathname;

/** Everything the package logged, for tests that assert on warnings. */
export const logs = [];
const capture = (...parts) => logs.push(parts.map(String).join(" "));

export async function connect() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.error("Run through tests/pg/run.mjs, which sets TEST_DATABASE_URL to the test database.");
    process.exit(2);
  }
  orm.DataSource.logger({ debug() {}, info: capture, warn: capture, error: capture });
  await orm.DataSource.initialize(PgDriver({ connectionString: url }));
  return new orm.DataSource();
}

let failed = 0;
let passed = 0;

export function section(title) {
  console.log(`\n${title}`);
}

export function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

export async function rejects(name, fn, pattern) {
  try {
    await fn();
    eq(name, "did not throw", `throws ${pattern}`);
  } catch (error) {
    const message = String(error?.message ?? error);
    eq(name, pattern.test(message) ? "throws as expected" : message.slice(0, 160), "throws as expected");
  }
}

export const said = (pattern) => logs.some((line) => pattern.test(line));

export async function done() {
  await orm.DataSource.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
