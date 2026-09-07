/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PartialInput } from "./optional";
import type { Repository, FindWhereOptions, ColumnOptions, IndexOptions } from "./repository";

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
  readonly schema: { columns: Record<string, ColumnOptions>; indexes?: readonly IndexOptions[] };
  hydrate: typeof Entity.hydrate;
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
  >(entityName: TName, schema: { columns: TCols, indexes?: readonly IndexOptions[] }) {
    
    /* A column with no `name` is named after its key. Done once here so every
       reader of the schema sees a name, rather than each one falling back. */
    for (const [key, opt] of Object.entries(schema.columns)) {
      if (!opt.name) {
        (opt as any).name = key;
      }
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
      readonly schema: { columns: TCols, indexes?: readonly IndexOptions[] };
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
