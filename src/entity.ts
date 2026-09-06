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
   * Internal reference tới Repository để xử lý Active Record.
   * Thuộc tính này sẽ được giấu đi khi JSON.stringify nhờ enumerable: false.
   */
  readonly _repository?: Repository<this>;

  /**
   * Khởi tạo Entity từ data lấy trong Database,
   * đồng thời bơm (inject) ngầm repository vào để Entity có thể tự save/delete.
   */
  static hydrate<T extends Entity>(
    this: new () => T,
    data: PartialInput<T>,
    repo: Repository<any>
  ): T {
    const instance = new this();
    Object.assign(instance, data);

    // Dùng defineProperty để nhét repo vào, đảm bảo enumerable: false
    // để khi JSON.stringify trả về API, thuộc tính này sẽ TÀNG HÌNH.
    Object.defineProperty(instance, "_repository", {
      value: repo,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    return instance;
  }

  /**
   * Tạo ra một Entity Class từ cấu hình Schema, tự động nội suy kiểu dữ liệu.
   */
  static create<
    TName extends string, 
    TCols extends Record<string, ColumnOptions>
  >(entityName: TName, schema: { columns: TCols, indexes?: readonly IndexOptions[] }) {
    
    // Chuẩn hoá: nếu không có name thì dùng luôn key
    for (const [key, opt] of Object.entries(schema.columns)) {
      if (!opt.name) {
        (opt as any).name = key;
      }
    }

    // Tạo một class ẩn kế thừa từ Entity
    class GeneratedEntity extends Entity {
      static readonly entityName = entityName;
      static readonly schema = schema;
    }

    // Ép kiểu để TypeScript tự động mixin các field từ schema vào InstanceType của class này
    return GeneratedEntity as unknown as {
      new (): GeneratedEntity & InferSchema<TCols>;
      readonly entityName: TName;
      readonly schema: { columns: TCols, indexes?: readonly IndexOptions[] };
      hydrate: typeof Entity.hydrate;
    };
  }

  /**
   * Lưu Entity vào Database.
   * Nếu đã có ID (khoá chính) thì sẽ gọi UPDATE.
   * Nếu chưa có thì sẽ gọi INSERT.
   */
  async save(): Promise<this> {
    const repo = this._repository;
    if (!repo) {
      throw new Error("Cannot save() a disconnected Entity. It must be created via Repository or injected manually.");
    }

    const pkField = repo.getPrimaryKeyField();
    const pkValue = (this as Record<string, unknown>)[pkField];

    if (pkValue) {
      // Đã có khoá chính => Update
      // Loại bỏ chính pkField ra khỏi data để update
      const updateData: Record<string, unknown> = { ...(this as unknown as Record<string, unknown>) };
      delete updateData[pkField];
      
      await repo.update({ [pkField]: pkValue } as FindWhereOptions<this>, updateData as Partial<this>);
      return this;
    } else {
      // Chưa có khoá chính => Insert
      const inserted = await repo.insert(this);
      Object.assign(this, inserted);
      return this;
    }
  }

  /**
   * Xoá record này khỏi Database.
   */
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
   * Tự động được gọi khi Next.js hoặc bất kỳ đâu chạy JSON.stringify(entity).
   * Dùng để kiểm soát chính xác những gì sẽ xuất hiện trên API JSON.
   */
  toJSON() {
    // Clone object để an toàn
    const json: Record<string, unknown> = { ...(this as unknown as Record<string, unknown>) };
    const repo = this._repository;
    
    // Xoá mọi thuộc tính ngầm nếu có (dù đã có enumerable: false nhưng làm thêm cho chắc)
    delete json._repository;

    // Tự động quét và xoá các trường được đánh dấu private: true trong schema
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
