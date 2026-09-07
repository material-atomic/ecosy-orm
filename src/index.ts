export * from "./data-source";
export * from "./entity";
export * from "./query-builder";
export * from "./repository";
export * from "./transaction";
/* The contract only. Built-in drivers live on their own subpaths and load
   their client package by dynamic import, so the root never pulls one in. */
export type * from "./drivers/types";
export * from "./optional";

/* `./migration` is not here, on the same reasoning as the drivers. It reads
   the filesystem — `node:fs/promises`, `node:path` — so exporting it from the
   root puts Node's builtins in the import graph of every consumer, including
   ones that only wanted a type. It lives at `@ecosy/orm/migration`. */
