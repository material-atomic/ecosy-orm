/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Entity } from "./entity";
import type { Queryable } from "./drivers/types";
import { DataSource } from "./data-source";
import { currentLogger } from "./logger";
import { createRepository, type Repository } from "./repository";
import { withLock } from "./lock";

/** What an effect is handed. Both halves are bound to the effect's own transaction. */
export interface EffectContext<T extends Entity = Entity> {
  /** A repository for the entity the effect is declared on. */
  repository: Repository<T>;
  /** Raw statements, for work a repository cannot express — a per-row random value, say. */
  tx: Queryable;
}

/**
 * Work that belongs to an entity's schema rather than to any request.
 *
 * Runs during schema sync, at one specific point: **after** columns have been
 * added, renamed and retyped, and **before** anything is tightened — `NOT NULL`
 * applied, a column dropped, a check or a foreign key added. That point is the
 * reason effects exist. It is the only moment where a new column is already
 * there to be written and the constraint that needs it filled is not yet there
 * to refuse the table, and the only moment a column about to be dropped can
 * still be read.
 *
 * - `"sync"` runs on every sync, which in practice is every boot. Write it to
 *   be idempotent — `WHERE code IS NULL` — so the runs after the first cost a
 *   query that matches nothing.
 * - `"once"` runs once per database and is recorded. The record is written in
 *   the same transaction as the work, so a failed run leaves no record and is
 *   attempted again; a succeeded one is never repeated. Renaming it makes it a
 *   different effect, which runs again.
 *
 * Each effect runs in its own transaction, under a lock per entity, so two
 * processes booting together take turns rather than both deciding a `"once"`
 * has not run yet. A throw rolls the effect back and fails the sync — boot
 * stops with the effect's name in the error, instead of a constraint failing
 * later with only the column's.
 *
 * @example
 * export class ProjectEntity extends Entity.create("projects", configs) {
 *   static effects: EntityEffect<ProjectEntity>[] = [
 *     {
 *       name: "backfill-code",
 *       when: "sync",
 *       // Rows from before `code` was required. Every row gets its own value:
 *       // gen_random_uuid() is volatile, so it is evaluated once per row.
 *       run: ({ tx }) => tx.query(
 *         `UPDATE projects SET code = left(gen_random_uuid()::text, 8) WHERE code IS NULL`,
 *       ),
 *     },
 *   ];
 * }
 */
export interface EntityEffect<T extends Entity = Entity> {
  /** Stable identity. For `"once"` it is what gets recorded. */
  name: string;
  when: "sync" | "once";
  run(context: EffectContext<T>): unknown;
}

const TRACKING_TABLE = "_ecosy_effects";

/** Every effect `EntityClass` declares, in declaration order. */
export async function runEffects(EntityClass: any): Promise<void> {
  const effects: EntityEffect<any>[] = EntityClass?.effects ?? [];
  if (!effects.length) return;

  const entityName: string = EntityClass.entityName;
  const q = (name: string) => DataSource.dialect.quote(name);
  const $ = (n: number) => DataSource.dialect.placeholder(n);
  const hasOnce = effects.some((effect) => effect.when === "once");

  const names = new Set<string>();
  for (const effect of effects) {
    /* Two effects under one name would share one record: the second `"once"`
       would be skipped forever because the first one ran. */
    if (names.has(effect.name)) {
      throw new Error(`[DB] ${entityName} declares two effects named "${effect.name}". Names must be unique.`);
    }
    names.add(effect.name);
  }

  await withLock(`ecosy:orm:effects:${entityName}`, async () => {
    if (hasOnce) {
      await DataSource.current.query(
        `CREATE TABLE IF NOT EXISTS ${q(TRACKING_TABLE)} (
           ${q("entity")} TEXT NOT NULL,
           ${q("name")} TEXT NOT NULL,
           ${q("ran_at")} TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
           PRIMARY KEY (${q("entity")}, ${q("name")})
         )`,
      );
    }

    for (const effect of effects) {
      try {
        await DataSource.transaction(async (tx) => {
          if (effect.when === "once") {
            /* Read inside the transaction, under the lock: a process that
               waited for the lock must see the record the one before it
               committed, not a snapshot from before it started waiting. */
            const done = await tx.query(
              `SELECT 1 FROM ${q(TRACKING_TABLE)} WHERE ${q("entity")} = ${$(1)} AND ${q("name")} = ${$(2)}`,
              [entityName, effect.name],
            );
            if (done.rows.length) return;
          }

          await effect.run({ repository: createRepository(EntityClass).using(tx) as any, tx });

          if (effect.when === "once") {
            await tx.query(
              `INSERT INTO ${q(TRACKING_TABLE)} (${q("entity")}, ${q("name")}) VALUES (${$(1)}, ${$(2)})`,
              [entityName, effect.name],
            );
            currentLogger().info(`[DB] Effect ${entityName}:${effect.name} ran, and will not run again.`);
          }
        });
      } catch (error) {
        currentLogger().error(`[DB] Effect ${entityName}:${effect.name} failed and was rolled back.`, error);
        throw error;
      }
    }
  });
}
