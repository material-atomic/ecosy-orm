/**
 * Runs every *.test.mjs / *.test.cjs here, each in its own process, against a
 * database reserved for them. See README.md.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

const base = process.env.DATABASE_URL;
if (!base) {
  console.error(
    "Set DATABASE_URL to a Postgres server. The tests run in their own database, " +
      "ecosy_orm_test, never in the one it names.",
  );
  process.exit(2);
}

const TEST_DB = "ecosy_orm_test";
const target = new URL(base);
target.pathname = `/${TEST_DB}`;

const admin = new pg.Client({ connectionString: base });
await admin.connect();
const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [TEST_DB]);
if (!found.rowCount) await admin.query(`CREATE DATABASE ${TEST_DB}`);
await admin.end();

const dir = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");
const only = args.filter((a) => !a.startsWith("--"));

/* How many checks each file ran last time it was agreed to be right.
   `failed: 0` catches a check that fails and "0 checks" catches a file that
   ran nothing — neither catches a file that quietly runs fewer than it did:
   a section behind an early return, a loop over an empty fixture. This does.
   Adding checks is never an error; it only asks for the baseline to be
   updated, so it does not break the way a per-file plan(n) would. */
const baselinePath = fileURLToPath(new URL("./baseline.json", import.meta.url));
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
const files = readdirSync(dir)
  .filter((f) => /\.test\.(mjs|cjs)$/.test(f))
  .filter((f) => !only.length || only.some((o) => f.includes(o)))
  .sort();

if (!files.length) {
  console.error(`No test files matched${only.length ? ` ${only.join(", ")}` : ""}. Nothing ran, which is not a pass.`);
  process.exit(1);
}

const results = [];
for (const file of files) {
  /* A clean schema per file, so no file depends on what another left. */
  const reset = new pg.Client({ connectionString: target.toString() });
  await reset.connect();
  await reset.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await reset.end();

  console.log(`\n━━ ${file}`);
  const run = spawnSync(process.execPath, [`${dir}${file}`], {
    env: { ...process.env, TEST_DATABASE_URL: target.toString() },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  /* Counted here, from what each file printed, so the total in a report is
     the runner's number rather than one added up by hand afterwards. */
  const tally = /(\d+) passed, (\d+) failed/.exec(run.stdout ?? "");
  results.push({
    file,
    ok: run.status === 0,
    passed: tally ? Number(tally[1]) : 0,
    failed: tally ? Number(tally[2]) : 0,
  });
}

console.log("\n━━ summary");
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.file.padEnd(28)} ${String(r.passed).padStart(4)} passed${r.failed ? `, ${r.failed} failed` : ""}`);
const shrunk = results.filter((r) => r.passed < (baseline[r.file] ?? 0));
const grew = results.filter((r) => r.passed > (baseline[r.file] ?? 0) && r.ok);
for (const r of shrunk) {
  console.log(`  ✗ ${r.file} ran ${r.passed} checks; the baseline says ${baseline[r.file]}. Checks went missing.`);
}

if (updateBaseline) {
  if (results.some((r) => !r.ok)) {
    console.log("\n  Baseline not updated: a file failed. Fix it first — a baseline records a good run.");
  } else {
    for (const r of results) baseline[r.file] = r.passed;
    writeFileSync(baselinePath, JSON.stringify(Object.fromEntries(Object.entries(baseline).sort()), null, 2) + "\n");
    console.log(`\n  Baseline updated (${results.length} files).`);
  }
} else if (grew.length) {
  console.log(`\n  More checks than the baseline in ${grew.map((r) => r.file).join(", ")} — run with --update-baseline and commit it.`);
}

const failedFiles = results.filter((r) => !r.ok).length + (updateBaseline ? 0 : shrunk.length);
const total = results.reduce((n, r) => n + r.passed, 0);
const totalFailed = results.reduce((n, r) => n + r.failed, 0);
console.log(`\n${results.length - failedFiles} of ${results.length} files passed · ${total} checks passed, ${totalFailed} failed`);
process.exit(failedFiles ? 1 : 0);
