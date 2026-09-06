import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";
import path from "path";
import { builtinModules } from "module";
import { glob } from "glob";

// Get all TypeScript files in src, excluding test files
const inputFiles = glob.sync("src/**/*.{ts,tsx}", {
  ignore: ["src/**/*.test.{ts,tsx}", "src/**/*.spec.{ts,tsx}", "**/vitest.setup.ts"],
});

// Create input object with file names as keys and paths as values
const input = inputFiles.reduce((acc, file) => {
  const relativePath = path.relative("src", file);
  const key = relativePath.replace(path.extname(relativePath), "");
  acc[key] = file;
  return acc;
}, {});

// Base external packages
//
// Node's own modules are on the list because this package runs on a server and
// imports them directly — `fs/promises` and `path` in the migration helpers.
// Without them Rollup tries to resolve the import, fails, warns, and leaves the
// require in place anyway: the build works and reports as if it did not.
const external = [
  "pg",
  "server-only",
  /^@ecosy\/.*/,
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  /^node:/,
];

/**
 * Warnings this build is not going to act on.
 *
 * EMPTY_BUNDLE fires for `optional` and `drivers/types`, which hold nothing
 * but types. They are still inputs on purpose — that is what makes Rollup's
 * TypeScript plugin emit their `.d.ts`, and `index.d.ts` re-exports both — so
 * an empty `.js` beside each is the cost of shipping the declarations, not a
 * mistake to fix.
 */
function onwarn(warning, warn) {
  if (warning.code === "EMPTY_BUNDLE") return;
  warn(warning);
}

// Minification configuration
const minifyOptions = {
  compress: {
    drop_console: true,
    drop_debugger: true,
    pure_funcs: ["console.log", "console.info", "console.debug"],
  },
  mangle: true,
};

// CommonJS build
const cjsConfig = {
  input,
  external,
  onwarn,
  output: {
    dir: "dist",
    format: "cjs",
    entryFileNames: "[name].js",
    chunkFileNames: "[name].js",
    exports: "named",
    preserveModules: true,
    preserveModulesRoot: "src",
    interop: "auto",
  },
  plugins: [
    typescript({
      tsconfig: "./tsconfig.json",
      declaration: true,
      declarationDir: "dist",
      rootDir: "src",
    }),
    terser(minifyOptions),
  ],
};

// ESM build
const esmConfig = {
  input,
  external,
  onwarn,
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].mjs",
    exports: "named",
    preserveModules: true,
    preserveModulesRoot: "src",
    interop: "auto",
    generatedCode: {
      symbols: true,
    },
  },
  plugins: [
    typescript({
      tsconfig: "./tsconfig.json",
      declaration: false,
      declarationDir: undefined,
      rootDir: "src",
    }),
    terser(minifyOptions),
  ],
};

/* There is no browser build.
 *
 * There was a UMD one, and it could never have run: `data-source.ts` and
 * `transaction.ts` import `server-only`, `migration.ts` imports `fs/promises`
 * and `path`, and Rollup was shimming all of it into globals named `fs` and
 * `path`. It produced a file, the file was broken, and nothing referenced it —
 * `main`, `module` and `exports` all point at dist/index.
 *
 * An ORM that opens sockets to Postgres has no browser story. Shipping a
 * bundle that claims otherwise is worse than shipping none.
 */

export default [cjsConfig, esmConfig];
