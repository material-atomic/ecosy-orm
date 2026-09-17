/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ColumnOptions, SchemaOptions } from "./repository";
import type { Entity, InferSchema } from "./entity";
import type { EffectContext, EntityEffect } from "./effects";
import type { WriteInput } from "./optional";
import { currentDialect } from "./drivers/current";
import { QueryBuilder } from "./query-builder";
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

/** A declared type as a cast target: a serial is an integer once it exists. */
function castType(declared: string): string {
  const serial = /^(small|big)?serial$/i.exec(declared.trim());
  if (!serial) return declared.trim();
  return serial[1]?.toLowerCase() === "big" ? "BIGINT" : serial[1] ? "SMALLINT" : "INTEGER";
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
      const $ = (n: number) => dialect.placeholder(n);
      const quoteTable = (reference: string) => reference.split(".").map((part) => q(part.replace(/"/g, ""))).join(".");
      const table = q(entityName);
      const builder = new QueryBuilder<InstanceType<C>>(entityName, schema, dialect);
      const sqlType = (property: string) => castType(String(schema.columns[property]!.type));
      const propertyOf = (column: string) =>
        Object.entries(schema.columns).find(([key, opt]) => String(opt.name ?? key) === column)?.[0];

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

      type Item = { index: number; row: Record<string, unknown> };

      /* Every comparison below is made by the database, never on JavaScript
         strings. Values are encoded as the repository writes them — a
         transformer applied — and cast to the column's type, so the database
         decides equality the way the table does: an upper-case UUID equals the
         lower-case one it stores. Comparing `String(seed)` with
         `String(stored)` made both look missing on the second boot, inserted
         them again, and stopped the boot on 23505. */
      const valuesOf = (part: readonly Item[], properties: readonly string[], params: unknown[]) =>
        part
          .map(({ index, row }) =>
            `(${index}, ${properties.map((property) => {
              params.push(builder.encodeValue(property, row[property]));
              return `CAST(${$(params.length)} AS ${sqlType(property)})`;
            }).join(", ")})`,
          )
          .join(", ");
      const aliases = (properties: readonly string[]) => properties.map((_, i) => `c${i}`).join(", ");

      /** Each item's values in the column's own text form, as the database renders them. */
      const canonical = async (items: readonly Item[], properties: readonly string[]) => {
        const out = new Map<number, string>();
        for (const part of chunks(items)) {
          const params: unknown[] = [];
          const found = await tx.query(
            `SELECT v.i AS i, ${properties.map((_, i) => `CAST(v.c${i} AS TEXT) AS k${i}`).join(", ")} ` +
              `FROM (VALUES ${valuesOf(part, properties, params)}) AS v(i, ${aliases(properties)})`,
            params,
          );
          for (const row of found.rows) out.set(Number(row.i), JSON.stringify(properties.map((_, i) => row[`k${i}`])));
        }
        return out;
      };

      const items: Item[] = list.map((row, index) => ({ index, row }));
      let candidates = items;

      if (mode === "missing") {
        for (const { index, row } of items) {
          const absent = key.filter((column) => row[column] === undefined || row[column] === null);
          if (absent.length) {
            throw new Error(`[Seeder] ${name}: row ${index} has no value for key ${absent.map((c) => `"${c}"`).join(", ")}.`);
          }
        }

        const keys = await canonical(items, key);
        const seen = new Map<string, number>();
        for (const { index, row } of items) {
          const value = keys.get(index)!;
          const first = seen.get(value);
          if (first !== undefined) {
            throw new Error(
              `[Seeder] ${name}: two rows share the key (${key.map((c) => String(row[c])).join(", ")}) — rows ${first} and ${index}, equal as the database compares them.`,
            );
          }
          seen.set(value, index);
        }

        /* Soft-deleted rows count as present: a seed does not bring back what
           was deleted that way. */
        const present = new Set<number>();
        for (const part of chunks(items)) {
          const params: unknown[] = [];
          const found = await tx.query(
            `SELECT v.i AS i FROM (VALUES ${valuesOf(part, key, params)}) AS v(i, ${aliases(key)}) ` +
              `JOIN ${table} t ON ${key.map((column, i) => `t.${q(String(schema.columns[column]!.name ?? column))} = v.c${i}`).join(" AND ")}`,
            params,
          );
          for (const row of found.rows) present.add(Number(row.i));
        }
        candidates = items.filter(({ index }) => !present.has(index));
      }

      /* Parents. A row whose `references` column points at nothing would fail
         the foreign key and stop boot over a row nobody needs any more — so it
         is skipped. A parent may be in the table, or, when the column refers to
         this same table, a row of this seed; those are inserted first. */
      type SelfReference = { property: string; inTable: Set<number>; child: Map<number, string>; parent: Map<number, string> };
      const selfReferences: SelfReference[] = [];
      const skippedRows: { index: number; why: string }[] = [];
      const bareTable = (reference: string) => reference.replace(/"/g, "").replace(/^public\./i, "").toLowerCase();

      for (const [property, column] of Object.entries(schema.columns)) {
        if (!column.references) continue;
        const target = referenceTarget(column.references);
        if (!target) continue;

        const withValue = candidates.filter(({ row }) => row[property] !== undefined && row[property] !== null);
        if (!withValue.length) continue;

        const inTable = new Set<number>();
        for (const part of chunks(withValue)) {
          const params: unknown[] = [];
          const found = await tx.query(
            `SELECT v.i AS i FROM (VALUES ${valuesOf(part, [property], params)}) AS v(i, c0) ` +
              `WHERE EXISTS (SELECT 1 FROM ${quoteTable(target.table)} p WHERE p.${q(target.column)} = v.c0)`,
            params,
          );
          for (const row of found.rows) inTable.add(Number(row.i));
        }

        const selfProperty = bareTable(target.table) === entityName.toLowerCase() ? propertyOf(target.column) : undefined;
        if (selfProperty) {
          const child = await canonical(withValue, [property]);
          const parent = await canonical(candidates.filter(({ row }) => row[selfProperty] !== undefined && row[selfProperty] !== null), [selfProperty]);
          selfReferences.push({ property, inTable, child, parent });
          continue;
        }

        candidates = candidates.filter(({ index, row }) => {
          if (row[property] === undefined || row[property] === null || inTable.has(index)) return true;
          skippedRows.push({ index, why: `${property} = ${String(row[property])} has no ${target.table}(${target.column})` });
          return false;
        });
      }

      /* Rows of this seed in the order they can go in: a row is ready once every
         row it points at is in the table or placed in an earlier level. A row
         whose parent never becomes ready — missing, skipped, or a cycle — is
         skipped with the rest. The order of the array does not matter, and
         neither does which chunk a parent would have fallen into. */
      const levels: Item[][] = [];
      if (selfReferences.length) {
        const placed = selfReferences.map(() => new Set<string>());
        let remaining = candidates;

        for (;;) {
          const ready = remaining.filter(({ index, row }) =>
            selfReferences.every((ref, i) =>
              row[ref.property] === undefined || row[ref.property] === null ||
              ref.inTable.has(index) || placed[i]!.has(ref.child.get(index)!),
            ),
          );
          if (!ready.length) break;

          levels.push(ready);
          for (const { index } of ready) {
            selfReferences.forEach((ref, i) => {
              const value = ref.parent.get(index);
              if (value !== undefined) placed[i]!.add(value);
            });
          }
          const readySet = new Set(ready.map(({ index }) => index));
          remaining = remaining.filter(({ index }) => !readySet.has(index));
        }

        for (const { index, row } of remaining) {
          const ref = selfReferences.find((r) => row[r.property] !== undefined && row[r.property] !== null && !r.inTable.has(index))!;
          skippedRows.push({ index, why: `${ref.property} = ${String(row[ref.property])} points at no row in ${entityName} or in this seed` });
        }
      } else if (candidates.length) {
        levels.push(candidates);
      }

      /* Warn, not info: a skipped row is data that did not go in, and nothing
         else would bring it to anyone's attention. */
      if (skippedRows.length) {
        const shown = skippedRows.slice(0, 3).map(({ index, why }) => `row ${index}: ${why}`).join("; ");
        currentLogger().warn(
          `[DB] ${name}: skipped ${skippedRows.length} row${skippedRows.length === 1 ? "" : "s"} whose parent is missing — ${shown}` +
            (skippedRows.length > 3 ? `; and ${skippedRows.length - 3} more.` : "."),
        );
      }

      let inserted = 0;
      for (const level of levels) {
        for (const part of chunks(level)) {
          await repository.insert(part.map(({ row }) => row) as any);
          inserted += part.length;
        }
      }

      if (inserted) {
        currentLogger().info(`[DB] ${name}: inserted ${inserted} row${inserted === 1 ? "" : "s"} into ${entityName}.`);
      }
    },
  };
}
