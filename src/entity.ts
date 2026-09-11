/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PartialInput } from "./optional";
import type { Repository, FindWhereOptions, ColumnOptions, IndexOptions, CheckOptions } from "./repository";
import type { EntityEffect } from "./effects";

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

  /**
   * Runs before a row is inserted, with `this` as the row about to be written.
   * Whatever it assigns is written; whatever it leaves `undefined` falls back
   * to the column's default.
   *
   * Called for `insert()`, for `upsert()` — a row there may become an insert,
   * and a `NOT NULL` column it fills is needed either way — and for `save()`
   * on a row with no primary key. It is not called for SQL written by hand.
   *
   * May be async; rows of a multi-row insert are prepared one after another,
   * then written in one statement.
   *
   * @example
   * class ProjectEntity extends Entity.create("projects", configs) {
   *   beforeInsert() {
   *     this.code ??= crypto.randomUUID().slice(0, 8);
   *   }
   * }
   */
  beforeInsert?(): void | Promise<void>;

  /**
   * Runs before an update, with `this` holding **only the fields being
   * written** — `update(where, patch)` is addressed by a WHERE clause that may
   * match many rows or none, so there is no single row to hand over. The one
   * exception is `save()`, which writes the whole instance.
   *
   * @example
   * beforeUpdate() {
   *   this.updatedAt = new Date().toISOString();
   * }
   */
  beforeUpdate?(): void | Promise<void>;

  /**
   * Runs on every row read back — `find`, `findOne`, and the rows `insert` and
   * `upsert` return. Synchronous on purpose: it runs once per row of every
   * query, and an await there is paid ten thousand times on a large page.
   * Prefer a getter for anything that can be computed when it is read.
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
      
      await repo.update({ [pkField]: pkValue } as FindWhereOptions<this>, updateData as PartialInput<this>);
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
