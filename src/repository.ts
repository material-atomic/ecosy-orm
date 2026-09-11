/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PartialInput } from "./optional";
import type { Entity as BaseEntity, EntityConstructor, HookContext } from "./entity";
import { DataSource } from "./data-source";
import { Transaction } from "./transaction";
import type { Queryable } from "./drivers/types";
import { QueryBuilder, SchemaBuilder } from "./query-builder";

type WriteHook =
  | "beforeInsert" | "afterInsert"
  | "beforeUpdate" | "afterUpdate"
  | "beforeRemove" | "afterRemove"
  | "beforeRestore" | "afterRestore";

/** Which rows beyond the live ones a call may reach, on an entity with `softDelete`. */
export interface ScopeOptions {
  withDeleted?: boolean | undefined;
  onlyDeleted?: boolean | undefined;
}

export interface DeleteOptions extends ScopeOptions {
  /**
   * Delete for real on a soft-deleting entity. The scope rule still holds:
   * live rows unless `withDeleted` / `onlyDeleted` — so a purge says
   * `{ hard: true, onlyDeleted: true }`.
   */
  hard?: boolean | undefined;
}

export type FindCondition<T> =
  | T
  | ReturnType<typeof Not<T>>
  | ReturnType<typeof Like>
  | ReturnType<typeof Between<T>>;

export type ObjectWhere<Entity extends BaseEntity> = {
  [K in keyof Entity]?: FindCondition<Entity[K]>;
};

export interface AndCondition<Entity extends BaseEntity> {
  type: "AND";
  conditions: FindWhereOptions<Entity>[];
}

export interface OrCondition<Entity extends BaseEntity> {
  type: "OR";
  conditions: FindWhereOptions<Entity>[];
}

export type FindWhereOptions<Entity extends BaseEntity> =
  | ObjectWhere<Entity>
  | AndCondition<Entity>
  | OrCondition<Entity>
  | FindWhereOptions<Entity>[];

export type OrderDirection = "ASC" | "DESC";

export interface FindOptions<Entity extends BaseEntity> {
  /* Each says `| undefined` so a caller under `exactOptionalPropertyTypes`
     can pass a value it computed as maybe-absent — see ./optional. */
  where?: FindWhereOptions<Entity> | undefined;
  /**
   * Column to direction, applied in the order the keys are written.
   *
   * Reach for it whenever `limit` is set: SQL does not promise which rows a
   * limit returns without one, and Postgres is free to answer differently on
   * the next call for the same query.
   *
   * `PartialInput` rather than `Partial` — the direction may itself be a value
   * the caller computed and it may be absent. See ./optional.
   */
  order?: PartialInput<Record<Extract<keyof Entity, string>, OrderDirection>> | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  /** Soft-deleting entities only: include soft-deleted rows. */
  withDeleted?: boolean | undefined;
  /** Soft-deleting entities only: return soft-deleted rows and nothing else. */
  onlyDeleted?: boolean | undefined;
}

/**
 * Groups conditions that must all hold.
 *
 * `NoInfer` on the arguments is what makes this callable. Without it TypeScript
 * tries to infer `Entity` from the conditions themselves, and cannot: a literal
 * like `{ name: "a" }` does not satisfy `extends BaseEntity` — an entity also
 * carries `save`, `delete` and `_repository` — so inference falls back to the
 * constraint and every column then reads as an excess property:
 *
 * ```
 * TS2353: Object literal may only specify known properties,
 *         and 'name' does not exist in type 'FindWhereOptions<Entity>'
 * ```
 *
 * Blocking that leaves one source of inference: the position the result is
 * used in. Inside `find({ where: … })` that is `FindWhereOptions<User>`, so
 * `Entity` comes out as `User` and the conditions are then checked against it
 * — unknown columns and wrong value types are still errors.
 *
 * The trade is that a call with no contextual type has nothing to infer from
 * and falls back to the constraint again. Annotate the variable when that
 * happens, or write the call where it is used:
 *
 * ```ts
 * const active: FindWhereOptions<User> = And({ status: "active" });
 * ```
 */
/**
 * A repository for an entity that has no class of its own.
 *
 * Lives here rather than on `DataSource` as it used to. `DataSource` needed
 * `Repository` as a value only for this, while `Repository` needs
 * `DataSource` for every query it runs — so the one method made the two
 * modules import each other, and a cycle in a package whose entry re-exports
 * both is a class that is `undefined` at the moment the other is evaluated.
 * One direction remains: repository → data-source.
 */
export function createRepository<Entity extends BaseEntity>(
  EntityClass: EntityConstructor<Entity>,
): Repository<Entity> {
  class DynamicRepository extends Repository<Entity> {}

  return new DynamicRepository(EntityClass);
}

export function And<Entity extends BaseEntity>(
  ...conditions: NoInfer<FindWhereOptions<Entity>>[]
): AndCondition<Entity> {
  return {
    type: "AND",
    conditions,
  };
}

/** Groups conditions where any may hold. Infers as {@link And} does. */
export function Or<Entity extends BaseEntity>(
  ...conditions: NoInfer<FindWhereOptions<Entity>>[]
): OrCondition<Entity> {
  return {
    type: "OR",
    conditions,
  };
}
export function Not<T>(value: T) {
  return {
    type: "NOT",
    value,
  } as const;
}
export function Like(value: string) {
  return {
    type: "LIKE",
    value,
  } as const;
}
export function Between<T>(value: [T, T]) {
  return {
    type: "BETWEEN",
    value,
  } as const;
}

export interface ColumnOptions {
  type: string;
  name?: string | undefined;
  primaryKey?: boolean | undefined;
  notNull?: boolean | undefined;
  /**
   * `true` — unique across every row, soft-deleted ones included.
   * `"live"` — unique among live rows only; needs `softDelete` on the entity.
   *
   * `true` is the safe default on purpose. A value a soft-deleted row gave up
   * can be taken by someone else, and for a label that sits inside a shared
   * link that means an old link opening another person's project. Getting
   * `true` wrong fails loudly with 23505; getting `"live"` wrong fails
   * silently. So the one that has to be asked for is the permissive one —
   * right for an email a deleted account should free for re-registration.
   *
   * A `"live"` column is a partial unique index, not a constraint, and a
   * foreign key cannot point at one: Postgres requires a full unique target.
   */
  unique?: boolean | "live" | undefined;
  default?: string | undefined;
  references?: string | undefined;
  private?: boolean | undefined;
  /**
   * Silences sync's warning that this foreign key's `ON DELETE` / `ON UPDATE`
   * action changes rows past the entity's hooks — for when that is the
   * point, as with a purge that relies on the cascade to clear children.
   */
  acknowledgeHookBypass?: boolean | undefined;
}

export interface IndexOptions {
  name: string;
  columns: readonly string[];
  /** `"live"`: unique among rows that are not soft-deleted. See {@link ColumnOptions.unique}. */
  unique?: boolean | "live" | undefined;
}

export interface CheckOptions {
  name: string;
  expression: string;
}

export interface SchemaOptions {
  columns: Record<string, ColumnOptions>;
  indexes?: readonly IndexOptions[] | undefined;
  /** The property key of the entity's soft-delete column. See `Entity.create`. */
  softDelete?: string | undefined;
  /**
   * Declared here or not at all.
   *
   * Sync drops every check on the table it does not find declared — including
   * ones it never created. A constraint added by hand in psql survives exactly
   * until the next boot, which is long enough to look like it worked.
   *
   * That is the same rule columns and indexes follow: the entity is the schema,
   * and anything the entity does not say is something the table should not
   * have. It is worth stating on this field because a CHECK is the one people
   * reach for a migration tool to add.
   */
  checks?: readonly CheckOptions[] | undefined;
}

export abstract class Repository<Entity extends BaseEntity> {
  public entityName: string;
  public schema: SchemaOptions;
  protected entityClass: new () => Entity;
  protected queryBuilder: QueryBuilder<Entity>;
  protected schemaBuilder: SchemaBuilder;
  /* Typed as Queryable, not DataSource: `using()` swaps in a Transaction, and
     everything here needs only `query`. */
  protected connection: Queryable;

  constructor(
    entityFactory: { new (): Entity, entityName: string, schema: SchemaOptions }
  ) {
    this.connection = new DataSource();
    this.entityClass = entityFactory;
    this.entityName = entityFactory.entityName;
    this.schema = entityFactory.schema;
    this.queryBuilder = new QueryBuilder<Entity>(this.entityName, this.schema);
    this.schemaBuilder = new SchemaBuilder(this.connection);
  }

  /**
   * The same repository, bound to a transaction.
   *
   * Returns a view rather than mutating: the original keeps running on the
   * pool, so a repository shared across requests cannot be dragged into one
   * request's transaction.
   *
   * @example
   * await DataSource.transaction(async (tx) => {
   *   await files.using(tx).delete({ projectId });
   *   await projects.using(tx).delete({ id: projectId });
   * });
   *
   * @param tx The transaction to run on.
   * @returns A repository of the same type whose statements go to `tx`.
   */
  using(tx: Queryable): this {
    /* The receiver becomes the prototype, so subclass methods and every other
       field are inherited and only `connection` is shadowed. */
    const bound = Object.create(this) as this;
    (bound as unknown as { connection: Queryable }).connection = tx;
    return bound;
  }

  getPrimaryKeyField(): string {
    const entry = Object.entries(this.schema.columns).find(([, v]) => v.primaryKey);
    return entry ? entry[0] : "id";
  }

  protected hydrateRows(rows: any[]): Entity[] {
    return rows.map(row => (this.entityClass as any).hydrate(row, this));
  }

  /**
   * What a hook is handed. Hooks only ever run inside {@link atomically}, so
   * `connection` is a transaction here — the caller's or one opened for the
   * write — and there is always a commit to attach to.
   */
  protected hookContext(extra: Partial<HookContext> = {}): HookContext {
    const tx = this.connection;
    return {
      ...extra,
      db: tx,
      afterCommit: (fn) => {
        if (!(tx instanceof Transaction)) {
          throw new Error("[Repository] afterCommit called outside a transaction.");
        }
        tx.afterCommit(fn);
      },
    };
  }

  /** Whether the entity declares this lifecycle hook. */
  protected has(hook: WriteHook): boolean {
    return typeof (this.entityClass.prototype as any)[hook] === "function";
  }

  /**
   * Runs `fn` on a transaction: this repository's own when it is already
   * bound to one, a new one otherwise.
   *
   * Used only when the entity declares a hook for the operation. A hook's work
   * and the write it belongs to have to land together — an `afterInsert` that
   * throws on the pool would report failure for a row that is already
   * committed. Entities without hooks keep the single statement they had.
   */
  protected atomically<T>(fn: (repo: this) => Promise<T>): Promise<T> {
    if (this.connection instanceof Transaction) return fn(this);
    return DataSource.transaction((tx) => fn(this.using(tx)));
  }

  /**
   * Runs `beforeInsert` or `beforeUpdate` over each row and returns what the
   * hook left behind.
   *
   * The hook gets a real instance as `this` — the same class `find` returns —
   * so it reads and assigns fields as it would anywhere else. What comes back
   * is the instance's own fields, which the builder then filters to declared
   * columns; nothing a hook adds that is not a column reaches the SQL.
   */
  protected async prepare(
    rows: PartialInput<Entity>[],
    hook: "beforeInsert" | "beforeUpdate",
  ): Promise<PartialInput<Entity>[]> {
    if (!this.has(hook)) return rows;

    const prepared: PartialInput<Entity>[] = [];
    for (const row of rows) {
      const instance = new this.entityClass();
      Object.assign(instance, row);
      await (instance as any)[hook](this.hookContext());
      prepared.push({ ...(instance as any) });
    }
    return prepared;
  }

  /** Runs an after-hook, or `beforeRemove`, over rows already read back. In order, one at a time. */
  protected async each(rows: Entity[], hook: WriteHook, extra: Partial<HookContext> = {}) {
    if (!this.has(hook)) return;
    const context = this.hookContext(extra);
    for (const row of rows) await (row as any)[hook](context);
  }

  /**
   * An after-hook needs the rows a write touched, and only `RETURNING` says
   * which. On an engine without it the hook could only be skipped — silently,
   * which is worse than refusing.
   */
  protected assertCanReturn(hook: WriteHook) {
    if (!this.queryBuilder.canReturn) {
      throw new Error(
        `[Repository] ${this.entityName} declares ${hook}(), which needs the rows a write ` +
          `touched, and driver "${DataSource.current.name}" cannot return them (no RETURNING).`,
      );
    }
  }

  /**
   * Brings this entity's table in line with its schema, running the entity's
   * effects at the point sync leaves room for them. See {@link EntityEffect}.
   */
  async syncSchema() {
    await this.schemaBuilder.syncSchema(this.entityName, this.schema, this.entityClass);
  }

  async find(options: FindOptions<Entity>): Promise<Entity[]> {
    const { sql, params } = this.queryBuilder.buildSelect(options);
    const result = await this.connection.query(sql, params);
    return this.hydrateRows(result.rows);
  }

  async findOne(options: FindOptions<Entity>): Promise<Entity | null> {
    const { sql, params } = this.queryBuilder.buildSelect({ ...options, limit: 1 });
    const result = await this.connection.query(sql, params);
    return result.rows.length ? this.hydrateRows(result.rows)[0] : null;
  }

  async insert(data: PartialInput<Entity>): Promise<Entity>;
  async insert(data: PartialInput<Entity>[]): Promise<Entity[]>;
  async insert(data: PartialInput<Entity> | PartialInput<Entity>[]): Promise<Entity | Entity[] | null> {
    const isArray = Array.isArray(data);
    const input = isArray ? data : [data];
    if (!input.length) return isArray ? [] : null;

    const run = async (repo: this) => {
      const arr = await repo.prepare(input, "beforeInsert");
      const { sql, params } = repo.queryBuilder.buildInsert(arr);
      const result = await repo.connection.query(sql, params);
      const rows = repo.hydrateRows(result.rows);
      await repo.each(rows, "afterInsert");
      return rows;
    };

    if (this.has("afterInsert")) this.assertCanReturn("afterInsert");
    const rows = this.has("beforeInsert") || this.has("afterInsert")
      ? await this.atomically(run)
      : await run(this);

    return isArray ? rows : (rows[0] ?? null);
  }

  /**
   * Updates every row matching `where`.
   *
   * A field set to `undefined` is not written — the column keeps what it had.
   * A patch with nothing left to write (after `beforeUpdate`) runs no statement
   * and reports no rows, rather than sending `SET` with nothing after it.
   *
   * `rows` holds the updated rows when they were asked for — `returning: true`,
   * or an entity that declares `afterUpdate` — and is empty otherwise.
   */
  async update(
    where: FindWhereOptions<Entity>,
    data: PartialInput<Entity>,
    options: { returning?: boolean | undefined } & ScopeOptions = {},
  ): Promise<{ rows: Entity[]; rowCount: number }> {
    const returning = Boolean(options.returning) || this.has("afterUpdate");
    if (this.has("afterUpdate")) this.assertCanReturn("afterUpdate");
    const scope = this.queryBuilder.resolveScope(where, options);

    const run = async (repo: this) => {
      const [patch] = await repo.prepare([data], "beforeUpdate");

      const soft = repo.schema.softDelete;
      if (soft && (patch as any)[soft] !== undefined) {
        throw new Error(
          `[Repository] update() on ${repo.entityName} sets "${soft}", the soft-delete column. ` +
            `Use delete() or restore(): writing it here would delete or restore past their hooks.`,
        );
      }

      const { sql, params } = repo.queryBuilder.buildUpdate(
        where,
        patch!,
        returning && repo.queryBuilder.canReturn,
        scope,
      );
      if (!sql) return { rows: [], rowCount: 0 };

      const result = await repo.connection.query(sql, params);
      const rows = returning ? repo.hydrateRows(result.rows) : [];
      await repo.each(rows, "afterUpdate");
      return { rows, rowCount: result.rowCount };
    };

    return this.has("beforeUpdate") || this.has("afterUpdate") ? this.atomically(run) : run(this);
  }

  /**
   * Deletes every row matching `where` — soft-deleting them, on an entity with
   * `softDelete`, unless `hard` is set.
   *
   * `rows` holds the removed rows when the entity declares `afterRemove`, and
   * is empty otherwise. With `beforeRemove`, the matching rows are read and
   * locked first, each one's hook runs, and exactly those rows are removed.
   * Both hooks see soft and hard deletes alike, told apart by `soft`.
   */
  async delete(
    where: FindWhereOptions<Entity>,
    options: DeleteOptions = {},
  ): Promise<{ rows: Entity[]; rowCount: number }> {
    const soft = Boolean(this.schema.softDelete) && !options.hard;

    /* A soft delete stamps live rows, and only live rows. Reaching deleted ones
       would stamp them again — erasing when they were deleted, which is the
       mark a restore uses to tell one deletion from another. */
    if (soft && (options.withDeleted || options.onlyDeleted)) {
      throw new Error(
        `[Repository] ${this.entityName}: a soft delete reaches live rows only. withDeleted / ` +
          `onlyDeleted apply with { hard: true }.`,
      );
    }
    const scope = this.queryBuilder.resolveScope(where, options);

    const before = this.has("beforeRemove");
    const after = this.has("afterRemove");
    if (after) this.assertCanReturn("afterRemove");

    const run = async (repo: this) => {
      let target = where;

      if (before) {
        /* Locked, so what the hooks approved is what goes: a concurrent write
           cannot slip a new match in between, or change a row after its hook
           looked at it. */
        const select = repo.queryBuilder.buildSelect({ where, withDeleted: options.withDeleted, onlyDeleted: options.onlyDeleted });
        const found = await repo.connection.query(`${select.sql} FOR UPDATE`, select.params);
        const rows = repo.hydrateRows(found.rows);
        if (!rows.length) return { rows: [], rowCount: 0 };

        await repo.each(rows, "beforeRemove", { soft });

        const pk = repo.getPrimaryKeyField();
        target = rows.map((row) => ({ [pk]: (row as any)[pk] })) as FindWhereOptions<Entity>;
      }

      const { sql, params } = soft
        ? repo.queryBuilder.buildSoftDelete(target, after)
        : repo.queryBuilder.buildDelete(target, after, scope);
      const result = await repo.connection.query(sql, params);
      const rows = after ? repo.hydrateRows(result.rows) : [];
      await repo.each(rows, "afterRemove", { soft });
      return { rows, rowCount: result.rowCount };
    };

    return before || after ? this.atomically(run) : run(this);
  }

  /**
   * Brings soft-deleted rows matching `where` back.
   *
   * All or nothing. Restoring a value that a live row has taken since — an
   * email re-registered, a file re-created at the same path, on a column or
   * index that is `unique: "live"` — fails the whole restore with the value
   * named, and nothing comes back.
   *
   * To restore what a parent took with it, match its stamp: soft-delete
   * stamps are the transaction's start time, so a parent and the children its
   * afterRemove deleted share one. In beforeRestore, `this` is still deleted
   * and still carries it:
   *
   * @example
   * async beforeRestore({ db }) {
   *   await new FileRepository().using(db).restore({ projectId: this.id, deletedAt: this.deletedAt });
   * }
   */
  async restore(where: FindWhereOptions<Entity>): Promise<{ rows: Entity[]; rowCount: number }> {
    if (!this.schema.softDelete) {
      throw new Error(`[Repository] restore() on ${this.entityName}, which has no softDelete column.`);
    }

    const before = this.has("beforeRestore");
    const after = this.has("afterRestore");
    if (after) this.assertCanReturn("afterRestore");

    const run = async (repo: this) => {
      let target = where;

      if (before) {
        const select = repo.queryBuilder.buildSelect({ where, onlyDeleted: true });
        const found = await repo.connection.query(`${select.sql} FOR UPDATE`, select.params);
        const rows = repo.hydrateRows(found.rows);
        if (!rows.length) return { rows: [], rowCount: 0 };

        await repo.each(rows, "beforeRestore");

        const pk = repo.getPrimaryKeyField();
        target = rows.map((row) => ({ [pk]: (row as any)[pk] })) as FindWhereOptions<Entity>;
      }

      const { sql, params } = repo.queryBuilder.buildRestore(target, after);
      let result;
      try {
        result = await repo.connection.query(sql, params);
      } catch (error: any) {
        if (error?.code === "23505") {
          throw new Error(
            `[Repository] Restoring ${repo.entityName} would duplicate a value a live row holds ` +
              `now${error.detail ? ` — ${error.detail}` : ""}. Nothing was restored.`,
            { cause: error },
          );
        }
        throw error;
      }
      const rows = after ? repo.hydrateRows(result.rows) : [];
      await repo.each(rows, "afterRestore");
      return { rows, rowCount: result.rowCount };
    };

    return before || after ? this.atomically(run) : run(this);
  }

  async upsert(data: PartialInput<Entity>, conflictColumns: string[]): Promise<Entity>;
  async upsert(data: PartialInput<Entity>[], conflictColumns: string[]): Promise<Entity[]>;
  async upsert(data: PartialInput<Entity> | PartialInput<Entity>[], conflictColumns: string[]): Promise<Entity | Entity[] | null> {
    const isArray = Array.isArray(data);
    const input = isArray ? data : [data];
    if (!input.length) return isArray ? [] : null;

    const run = async (repo: this) => {
      const arr = await repo.prepare(input, "beforeInsert");
      const { sql, params } = repo.queryBuilder.buildUpsert(arr, conflictColumns);
      const result = await repo.connection.query(sql, params);
      return repo.hydrateRows(result.rows);
    };

    const rows = this.has("beforeInsert") ? await this.atomically(run) : await run(this);
    return isArray ? rows : (rows[0] ?? null);
  }
}
