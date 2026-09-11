/**
 * Fails the build when dist/ reaches for tslib.
 *
 * @rollup/plugin-typescript forces `importHelpers: true`, and tslib is only a
 * devDependency here. Any syntax newer than the target makes TypeScript emit a
 * helper import, which `preserveModules` then turns into
 * dist/node_modules/tslib/… — a path that exists on this machine and in no
 * consumer's install. That is how 1.1.3 shipped broken. The target was raised
 * so no helper is needed today; this is what keeps the next one from shipping
 * quietly.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
const problems = [];

if (existsSync(join(dist, "node_modules"))) problems.push("dist/node_modules exists");

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(m?js|cjs)$/.test(name) && /["']tslib["']|\/tslib\//.test(readFileSync(path, "utf8"))) {
      problems.push(`${path.slice(dist.length)} imports tslib`);
    }
  }
};
walk(dist);

if (problems.length) {
  console.error(
    `[check-dist] ${problems.join("; ")}.\n` +
      `A TypeScript helper was emitted. Raise "target" in tsconfig.json so the syntax needs no ` +
      `helper, or make tslib a dependency and external in rollup — never ship dist/node_modules.`,
  );
  process.exit(1);
}
console.log("[check-dist] no tslib, no nested node_modules");
