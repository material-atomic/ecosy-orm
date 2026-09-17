/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ColumnOptions, SchemaOptions } from "./repository";
import type { Entity, InferSchema } from "./entity";
import type { EffectContext, EntityEffect } from "./effects";
import type { WriteInput } from "./optional";
import { currentDialect } from "./drivers/current";
import { currentLogger } from "./logger";

/** Rows for a seed, or a function returning them — for data that has to be read when the seed runs. */
export type SeedRows<Row> = readonly Row[] | (() => readonly Row[] | Promise<readonly Row[]>);

type Columns<C> = C extends { schema: { columns: infer Cols extends Record<string, ColumnOptions> } } ? Cols : Record<string, ColumnOptions>;

/** One seed row: the entity's columns, each optional, as `insert` takes them. */
export type SeedRow<C> = WriteInput<InferSchema<Columns<C>>>;

export interface SeederOptions<C> {
  /**
   * The columns that identify a row. Default: the primary key.
   *
   * They must be guaranteed unique — the primary key, a column declared
   * `unique`, or a unique index over exactly these columns. "Insert what is
   * missing" over a key nothing keeps unique would insert duplicates quietly.
   */
  key?: readonly (keyof Columns<C> & string)[] | undefined;
  /**
   * - `"missing"` (default): insert every row whose key is not in the table,
   *   soft-deleted rows included; never change a row that exists.
   * - `"empty"`: insert the rows only while the table has no row at all — for a
   *   first value that the application owns from then on.
   *
   * There is no mode that overwrites: a seed that writes over existing rows
   * undoes, on every deploy, whatever was changed since.
   */
  mode?: "missing" | "empty" | undefined;
  /**
   * `"sync"` (default) runs on every sync, so a row added to the seed reaches a
   * database that already exists. `"once"` runs once per database — and a row
   * that is deleted is then not put back.
   *
   * Note what `"sync"` with `"missing"` means for a hard delete: the row is
   * missing, so it is inserted again on the next boot.
   */
  when?: "sync" | "once" | undefined;
  /**
   * The effect's name. Default `seed:<entity>`. For `"once"` it is what is
   * recorded, so it must stay the same: a new name is a new effect, which runs
   * again. Two seeders on one entity need names of their own.
   */
  name?: string | undefined;
}

/** How many rows go in one lookup or one insert. */
const CHUNK = 500;

function chunks<T>(list: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** `plans(id) ON DELETE CASCADE` → `{ table: "plans", column: "id" }`. Composite targets are not understood. */
function referenceTarget(references: string): { table: string; column: string } | null {
  const match = /^\s*"?([\w.]+?)"?\s*\(\s*"?(\w+)"?\s*\)/.exec(references);
  return match ? { table: match[1]!, column: match[2]! } : null;
}

/** Whether the schema guarantees `key` is unique. */
function keyIsUnique(schema: SchemaOptions, key: readonly string[]): boolean {
  const sameSet = (columns: readonly string[]) =>
    columns.length === key.length && columns.every((column) => key.includes(column));

  if (key.length === 1) {
    const column = schema.columns[key[0]!];
    if (column?.primaryKey || column?.unique) return true;
  }
  return (schema.indexes ?? []).some((index) => Boolean(index.unique) && sameSet(index.columns));
}

/**
 * An effect that seeds an entity's table with rows declared in code.
 *
 * Put it in the entity's `effects`. It runs where effects run — during sync,
 * in its own transaction, under the entity's lock, so replicas booting together
 * take turns — and inserts through the effect's repository, so `beforeInsert`,
 * `afterInsert` and column transformers apply to seeded rows as to any other.
 *
 * Refused, and the sync with it:
 * - a key that no primary key, `unique` column or unique index guarantees —
 *   at declaration, before anything runs;
 * - a row naming a property that is not a column: it would otherwise be
 *   dropped without a word, typo included;
 * - a row with no value for a key column, and two rows with the same key.
 *
 * Handled, because each has broken a hand-written seed before:
 * - **JSON columns**, through the repository: `null` in a `NOT NULL` JSONB
 *   column is JSON `null` — not SQL NULL, which the column refuses — and a
 *   string is a JSON string. In a nullable JSON column `null` stays SQL NULL.
 * - **Missing parents.** A row whose `references` column points at a row that
 *   does not exist is skipped, and counted in the log, instead of failing the
 *   foreign key and stopping boot. Read from the column's `references`; no
 *   option needed.
 *
 * @example
 * export class PlanEntity extends Entity.create("plans", schema) {
 *   static effects: EntityEffect<PlanEntity>[] = [
 *     Seeder(PlanEntity, () => PLAN_SEED.map(({ features, ...plan }) => plan)),
 *   ];
 * }
 *
 * export class AdminEntity extends Entity.create("admins", schema) {
 *   static effects: EntityEffect<AdminEntity>[] = [
 *     Seeder(AdminEntity, () => adminEmails().map((email) => ({ email })), {
 *       mode: "empty",
 *       name: "seed-first-admins",
 *     }),
 *   ];
 * }
 *
 * @param EntityClass - The entity whose table is seeded. Also what types the rows.
 * @param rows - The rows, or a function returning them.
 * @param options - Key, mode, when and name.
 * @returns An effect for the entity's `effects`.
 * @throws {Error} At declaration, when the key is not guaranteed unique.
 */
export function Seeder<C extends (new () => Entity) & { entityName: string; schema: SchemaOptions }>(
  EntityClass: C,
  rows: SeedRows<SeedRow<C>>,
  options: SeederOptions<C> = {},
): EntityEffect<InstanceType<C>> {
  const { entityName, schema } = EntityClass;
  const mode = options.mode ?? "missing";

  const primaryKey = Object.entries(schema.columns).filter(([, column]) => column.primaryKey).map(([key]) => key);
  const key: string[] = options.key ? [...options.key] : primaryKey;

  if (mode === "missing") {
    if (!key.length) {
      throw new Error(`[Seeder] ${entityName} has no primary key; give the seeder a \`key\`.`);
    }
    for (const column of key) {
      if (!(column in schema.columns)) {
        throw new Error(`[Seeder] ${entityName} has no column "${column}" to use as the seed key.`);
      }
    }
    if (!keyIsUnique(schema, key)) {
      throw new Error(
        `[Seeder] ${entityName} key (${key.join(", ")}) is not guaranteed unique — no primary key, unique column ` +
          `or unique index covers exactly those columns. Inserting "what is missing" over it could insert duplicates. ` +
          `Declare the unique index, or key the seed on columns that have one.`,
      );
    }
  }

  const name = options.name ?? `seed:${entityName}`;

  return {
    name,
    when: options.when ?? "sync",
    async run(context: EffectContext<InstanceType<C>>) {
      const { repository, tx } = context;
      const dialect = currentDialect();
      const q = (identifier: string) => dialect.quote(identifier);
      const dbName = (property: string) => String(schema.columns[property]?.name ?? property);
      const table = q(entityName);

      const list = (typeof rows === "function" ? await rows() : rows) as readonly Record<string, unknown>[];
      if (!list.length) return;

      /* Properties that are not columns. The repository would drop them, and a
         misspelt column would become a row seeded without that value. */
      list.forEach((row, index) => {
        const unknown = Object.keys(row).filter((property) => !(property in schema.columns));
        if (unknown.length) {
          throw new Error(
            `[Seeder] ${name}: row ${index} has ${unknown.map((p) => `"${p}"`).join(", ")}, which ${unknown.length === 1 ? "is not a column" : "are not columns"} of ${entityName}. ` +
              `Map the rows to the entity's columns before seeding them.`,
          );
        }
      });

      if (mode === "empty") {
        const any = await tx.query(`SELECT 1 FROM ${table} LIMIT 1`);
        if (any.rows.length) return;
      }

      let candidates = list;

      if (mode === "missing") {
        const tupleOf = (row: Record<string, unknown>) => JSON.stringify(key.map((column) => String(row[column])));
        const seen = new Set<string>();

        list.forEach((row, index) => {
          const absent = key.filter((column) => row[column] === undefined || row[column] === null);
          if (absent.length) {
            throw new Error(`[Seeder] ${name}: row ${index} has no value for key ${absent.map((c) => `"${c}"`).join(", ")}.`);
          }
          const tuple = tupleOf(row);
          if (seen.has(tuple)) {
            throw new Error(`[Seeder] ${name}: two rows share the key (${key.map((c) => String(row[c])).join(", ")}).`);
          }
          seen.add(tuple);
        });

        /* Raw rather than through the repository: soft-deleted rows count as
           present — a seed does not bring back what was deleted that way. */
        const existing = new Set<string>();
        const columns = key.map((column) => q(dbName(column)));

        for (const part of chunks(list)) {
          const params: unknown[] = [];
          const tuples = part.map((row) =>
            `(${key.map((column) => {
              params.push(row[column]);
              return dialect.placeholder(params.length);
            }).join(", ")})`,
          );
          const target = key.length === 1 ? columns[0] : `(${columns.join(", ")})`;
          const values = key.length === 1 ? tuples.map((tuple) => tuple.slice(1, -1)) : tuples;
          const found = await tx.query(
            `SELECT ${key.map((column, i) => `${columns[i]} AS ${q(column)}`).join(", ")} FROM ${table} ` +
              `WHERE ${target} IN (${values.join(", ")})`,
            params,
          );
          for (const row of found.rows) existing.add(tupleOf(row));
        }

        candidates = list.filter((row) => !existing.has(tupleOf(row)));
      }

      /* Rows whose parent is not there. A foreign key would refuse them, and
         the throw would stop boot over a row nobody needs any more. */
      let skipped = 0;
      for (const [property, column] of Object.entries(schema.columns)) {
        if (!column.references || !candidates.length) continue;
        const target = referenceTarget(column.references);
        if (!target) continue;

        const values = [...new Set(candidates.map((row) => row[property]).filter((value) => value !== undefined && value !== null))];
        if (!values.length) continue;

        const present = new Set<string>();
        for (const part of chunks(values)) {
          const found = await tx.query(
            `SELECT ${q(target.column)} AS v FROM ${q(target.table)} WHERE ${q(target.column)} IN (${part.map((_, i) => dialect.placeholder(i + 1)).join(", ")})`,
            part,
          );
          for (const row of found.rows) present.add(String(row.v));
        }

        const before = candidates.length;
        candidates = candidates.filter((row) => {
          const value = row[property];
          return value === undefined || value === null || present.has(String(value));
        });
        skipped += before - candidates.length;
      }

      if (!candidates.length) {
        if (skipped) currentLogger().info(`[DB] ${name}: nothing to insert; ${skipped} row${skipped === 1 ? "" : "s"} skipped, parent missing.`);
        return;
      }

      /* JSON values need nothing here: the repository serialises them — null
         as JSON null in a NOT NULL column, a string as a JSON string. */
      const prepared = candidates;

      for (const part of chunks(prepared)) {
        await repository.insert(part as any);
      }

      currentLogger().info(
        `[DB] ${name}: inserted ${prepared.length} row${prepared.length === 1 ? "" : "s"} into ${entityName}` +
          (skipped ? `; ${skipped} skipped, parent missing.` : "."),
      );
    },
  };
}
