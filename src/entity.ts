/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PartialInput } from "./optional";
import type { Repository, FindWhereOptions, ColumnOptions, IndexOptions, CheckOptions } from "./repository";
import type { EntityEffect } from "./effects";
import type { Queryable } from "./drivers/types";

/**
 * What a lifecycle hook is handed.
 *
 * `db` is the connection the write itself is running on. Whenever an entity
 * declares a hook for an operation, that operation runs in a transaction —
 * the caller's, when the repository was bound with `using(tx)`, or one opened
 * for it otherwise — so a hook that writes through `db` commits or rolls back
 * together with the row it was called for, and a hook that throws undoes the
 * write. That is what TypeORM does around `save()`, for the same reason.
 */
export interface HookContext {
  db: Queryable;
  /**
   * Defers `fn` until the transaction the write is in commits; dropped if it
   * rolls back. When the repository was bound with `using(tx)`, that is the
   * caller's commit — not the end of this repository call. See
   * `Transaction.afterCommit` for what it does and does not guarantee.
   *
   * @example
   * afterUpdate({ afterCommit }) {
   *   afterCommit(() => realtime.publish(`project:${this.id}`, "changed"));
   * }
   */
  afterCommit(fn: () => unknown): void;
}

export type InferColumnType<T extends string> = 
  T extends "TEXT" | "UUID" ? string :
  T extends "INTEGER" | "BIGINT" | "FLOAT" | "SERIAL" ? number :
  T extends "BOOLEAN" ? boolean :
  T extends "TIMESTAMP" | "TIMESTAMPTZ" | "DATE" ? string :
  unknown;

export type InferSchema<TCols extends Record<string, ColumnOptions>> = {
  -readonly [K in keyof TCols]: TCols[K]["notNull"] extends true 
    ? InferColumnType<TCols[K]["type"]> 
    : InferColumnType<TCols[K]["type"]> | null;
};

export type EntityConstructor<T extends Entity = Entity> = {
  new (): T;
  readonly entityName: string;
  readonly schema: { columns: Record<string, ColumnOptions>; indexes?: readonly IndexOptions[]; checks?: readonly CheckOptions[] };
  hydrate: typeof Entity.hydrate;
  /** Declared as a static on a subclass. See {@link EntityEffect}. */
  readonly effects?: readonly EntityEffect<any>[];
};

export abstract class Entity {
  /**
   * The repository this row came from, for {@link save} and {@link delete}.
   *
   * Defined as non-enumerable in {@link hydrate}, so it does not appear in
   * `JSON.stringify` — a row handed to a response would otherwise carry a
   * whole repository, and with it the connection, into the body.
   */
  readonly _repository?: Repository<this>;

  /*
   * Lifecycle hooks. Declare any of them as a method on the subclass; `this` is
   * a real instance of it. Each one is looked up once per call and costs
   * nothing on an entity that does not declare it.
   *
   * Unlike TypeORM, these fire on the repository's bulk methods too — `update`
   * and `delete` by WHERE, not only on `save()` and `remove()` of a loaded
   * entity. A hook that only some call sites trigger is a rule only some call
   * sites follow, which is the problem hooks exist to remove.
   *
   * **What that promise does not cover: rows the database changes itself.** A
   * foreign key declared `ON DELETE CASCADE` deletes this entity's rows when
   * the row they reference goes, and Postgres does it — the ORM issues no
   * statement, so `beforeRemove` and `afterRemove` never run. Deleting a
   * project that cascades to its messages bypasses every hook on the message
   * entity, silently. `ON DELETE SET NULL`, `SET DEFAULT` and `ON UPDATE
   * CASCADE` do the same to `beforeUpdate` and `afterUpdate`. Nothing at this
   * layer can intercept that.
   *
   * Sync warns when an entity declares one of those hooks and a foreign key in
   * its own `references` that bypasses it. A hook that must hold on every
   * path — refusing to delete a message, say — cannot rely on the cascade:
   * drop it for `ON DELETE RESTRICT` and delete children through the
   * repository, or enforce the rule in the database with a trigger. Keys
   * created in hand-written SQL, and rows changed by hand-written SQL, are
   * outside what sync can see.
   *
   * `upsert()` runs `beforeInsert` but no after-hook: the statement does not
   * say, per row, whether it inserted or updated, and guessing would run the
   * wrong one.
   */

  /**
   * Before a row is inserted, with `this` as the row about to be written.
   * Whatever it assigns is written; whatever it leaves `undefined` falls back
   * to the column's default.
   *
   * Runs for `insert()`, `upsert()` and `save()` on a row with no primary key.
   * Rows of a multi-row insert are prepared one after another, then written in
   * one statement.
   *
   * @example
   * class ProjectEntity extends Entity.create("projects", configs) {
   *   beforeInsert() {
   *     this.code ??= crypto.randomUUID().slice(0, 8);
   *   }
   * }
   */
  beforeInsert?(context: HookContext): void | Promise<void>;

  /**
   * After a row is inserted, with `this` as the row as stored — generated id
   * and defaults included. Throwing rolls the insert back.
   *
   * @example
   * async afterInsert({ db }) {
   *   await db.query(`INSERT INTO audit (entity, id) VALUES ('projects', $1)`, [this.id]);
   * }
   */
  afterInsert?(context: HookContext): void | Promise<void>;

  /**
   * Before an update, with `this` holding **only the fields being written** —
   * `update(where, patch)` is addressed by a WHERE clause that may match many
   * rows or none, so there is no single row to hand over. `save()` is the
   * exception: it writes, and so hands over, the whole instance.
   *
   * @example
   * beforeUpdate() {
   *   this.updatedAt = new Date().toISOString();
   * }
   */
  beforeUpdate?(context: HookContext): void | Promise<void>;

  /**
   * After an update, once per row it changed, with `this` as that row as now
   * stored. Declaring it makes the update return the rows (`RETURNING`), which
   * is the only way to know which rows those were. Throwing rolls it back.
   */
  afterUpdate?(context: HookContext): void | Promise<void>;

  /**
   * Before a row is deleted, once per row about to go, with `this` as that
   * row. Throwing stops the delete — nothing is removed.
   *
   * A delete by WHERE names no rows, so declaring this makes `delete()` read
   * the matching rows first, locked (`FOR UPDATE`), and then delete exactly
   * those: a row that starts matching in between is not removed without its
   * hook having seen it.
   */
  beforeRemove?(context: HookContext): void | Promise<void>;

  /**
   * After a row is deleted, once per row removed, with `this` as the row as it
   * was. Declaring it makes the delete return the rows (`RETURNING`). Throwing
   * rolls the delete back.
   */
  afterRemove?(context: HookContext): void | Promise<void>;

  /**
   * On every row read back — `find`, `findOne`, and the rows a write returns.
   * Synchronous on purpose: it runs once per row of every query, and an await
   * there is paid ten thousand times on a large page. Prefer a getter for
   * anything that can be computed when it is read.
   */
  afterLoad?(): void;

  /**
   * Builds an entity from a database row and attaches the repository it came
   * from, which is what makes `row.save()` and `row.delete()` possible.
   */
  static hydrate<T extends Entity>(
    this: new () => T,
    data: PartialInput<T>,
    repo: Repository<any>
  ): T {
    const instance = new this();
    Object.assign(instance, data);

    if (typeof instance.afterLoad === "function") {
      const result: unknown = instance.afterLoad();
      /* A floating promise here would be a hook that silently never finished
         before the row was used. */
      if (result && typeof (result as Promise<unknown>).then === "function") {
        throw new Error(
          `[Entity] afterLoad() returned a promise. It must be synchronous: it runs on every ` +
            `row of every query. Compute on read with a getter, or load in the repository.`,
        );
      }
    }

    /* defineProperty rather than assignment, for `enumerable: false`: the
       reference has to be invisible to `JSON.stringify`, to spreads and to
       `Object.keys`, none of which an ordinary property can hide from. */
    Object.defineProperty(instance, "_repository", {
      value: repo,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    return instance;
  }

  /**
   * Builds an entity class from a schema, with the column types inferred.
   *
   * Pass the schema `as const` — the field types come from the literal types of
   * `columns`, and without it every column widens to `string` and the inference
   * this exists for produces nothing.
   */
  static create<
    TName extends string, 
    TCols extends Record<string, ColumnOptions>
  >(entityName: TName, schema: { columns: TCols, indexes?: readonly IndexOptions[]; checks?: readonly CheckOptions[] }) {
    
    /* A column with no `name` is named after its key. Done once here so every
       reader of the schema sees a name, rather than each one falling back. */
    for (const [key, opt] of Object.entries(schema.columns)) {
      if (!opt.name) {
        (opt as any).name = key;
      }
    }

    /* Composite primary keys are refused here, at declaration, rather than
       later at CREATE TABLE.
       
       The DDL failure is the smaller half. `save()` and `delete()` identify a
       row through `getPrimaryKeyField()`, which returns ONE column — the first
       declared. Given a two-column key, `delete()` on a `memberships` row keyed
       (user_id, project_id) issues `WHERE user_id = ?` and removes that user's
       membership of every project. No error, no warning, and the row that was
       asked for does go away, so nothing looks wrong until something counts.
       
       So this is not a gap to be filled by emitting a table-level PRIMARY KEY:
       doing that alone would trade a loud failure at startup for silent data
       loss at run time. Row identity is single-column all the way through the
       entity layer, and the schema has to say so.
       
       The shape that works: a surrogate key column, plus a unique index over
       the columns that used to be the key. `upsert(data, conflictColumns)`
       needs only the unique index, so ON CONFLICT is unaffected. */
    const primaryKeys = Object.entries(schema.columns).filter(([, opt]) => opt.primaryKey);

    if (primaryKeys.length > 1) {
      const names = primaryKeys.map(([key]) => key).join(", ");
      throw new Error(
        `[Entity] "${entityName}" declares ${primaryKeys.length} primary key columns ` +
          `(${names}). A row is identified by a single column here — save() and ` +
          `delete() both filter on one — so a composite key would delete and ` +
          `overwrite rows that merely share the first column. Use one surrogate ` +
          `key and a unique index over (${names}); upsert() needs only the index.`,
      );
    }

    /* Anonymous on purpose: the class is an implementation detail, and what
       the caller keeps is the type below, not this binding. */
    class GeneratedEntity extends Entity {
      static readonly entityName = entityName;
      static readonly schema = schema;
    }

    /* The cast is the whole feature. `GeneratedEntity` has no declared fields —
       they exist only in the schema — so this is what tells TypeScript that an
       instance carries a property per column, with the type each column
       declared. */
    return GeneratedEntity as unknown as {
      new (): GeneratedEntity & InferSchema<TCols>;
      readonly entityName: TName;
      readonly schema: { columns: TCols, indexes?: readonly IndexOptions[]; checks?: readonly CheckOptions[] };
      hydrate: typeof Entity.hydrate;
    };
  }

  /**
   * Writes this row back.
   *
   * A primary key means the row exists and this is an UPDATE; no primary key
   * means an INSERT, and the generated values are copied back onto this
   * instance so it goes on describing the row it just created.
   */
  async save(): Promise<this> {
    const repo = this._repository;
    if (!repo) {
      throw new Error("Cannot save() a disconnected Entity. It must be created via Repository or injected manually.");
    }

    const pkField = repo.getPrimaryKeyField();
    const pkValue = (this as Record<string, unknown>)[pkField];

    if (pkValue) {
      /* The key identifies the row; it is not part of what changes. Leaving it
         in the SET list is an assignment of a column to itself at best, and a
         rejected update on a generated key at worst. */
      const updateData: Record<string, unknown> = { ...(this as unknown as Record<string, unknown>) };
      delete updateData[pkField];
      
      /* Read back, so this instance goes on describing the row: whatever
         beforeUpdate assigned went to a copy, and would otherwise be written
         to the database and missing from here. */
      const { rows } = await repo.update(
        { [pkField]: pkValue } as FindWhereOptions<this>,
        updateData as PartialInput<this>,
        { returning: true },
      );
      if (rows[0]) Object.assign(this, rows[0]);
      return this;
    } else {
      const inserted = await repo.insert(this);
      Object.assign(this, inserted);
      return this;
    }
  }

  /** Removes this row. */
  async delete(): Promise<void> {
    const repo = this._repository;
    if (!repo) {
      throw new Error("Cannot delete() a disconnected Entity.");
    }

    const pkField = repo.getPrimaryKeyField();
    const pkValue = (this as Record<string, unknown>)[pkField];

    if (!pkValue) {
      throw new Error("Cannot delete() an Entity that does not have a primary key value.");
    }

    await repo.delete({ [pkField]: pkValue } as FindWhereOptions<this>);
  }

  /**
   * What this row looks like once serialised.
   *
   * `JSON.stringify` calls it, which means every framework that turns a value
   * into a response body calls it without being asked — so this is the last
   * place a column can be kept out of an API, and the only one that catches
   * every route at once.
   */
  toJSON() {
    /* A copy: what follows deletes keys, and doing that to the entity itself
       would empty the row every time it was serialised. */
    const json: Record<string, unknown> = { ...(this as unknown as Record<string, unknown>) };
    const repo = this._repository;
    
    /* Belt and braces. `hydrate` makes it non-enumerable so the spread above
       should not have copied it — but an instance built any other way has an
       ordinary property here, and that one would travel. */
    delete json._repository;

    /* Columns marked `private` never leave. Declared once on the schema rather
       than remembered at each route, because a password hash omitted in four
       places and forgotten in the fifth is the same as never omitting it. */
    if (repo && repo.schema && repo.schema.columns) {
      for (const [colName, options] of Object.entries(repo.schema.columns)) {
        if (options.private) {
          delete json[colName];
        }
      }
    }

    return json;
  }
}
