/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";

import type { PoolConfig } from "pg";
import { Pool } from "pg";
import { freeze } from "@ecosy/core/utilities";
import type { Entity as BaseEntity, EntityConstructor } from "./entity";
import { Repository } from "./repository";

export class DataSource {
  private static _configs: PoolConfig;
  private static _entities: EntityConstructor<any>[] = [];

  constructor(configs?: PoolConfig) {
    console.log("[DataSource] constructor() called.");
    if (configs) {
      const g = globalThis as any;
      if (!g.__ECOSY_ORM_POOL) {
        console.log("[DataSource] Creating new Pool...");
        DataSource._configs = freeze(configs) as PoolConfig;
        g.__ECOSY_ORM_POOL = new Pool(DataSource._configs);
      } else {
        console.log("[DataSource] Pool already exists!");
      }
    }
  }

  static get pool(): Pool {
    return (globalThis as any).__ECOSY_ORM_POOL;
  }

  static entities(entities: EntityConstructor<any>[]) {
    console.log("[DataSource] entities() called with", entities.map(e => e.name || e.entityName));
    this._entities = Array.from(new Set([...entities]));
    return this;
  }

  static async initialize(configs: PoolConfig) {
    console.log("[DataSource] initialize() called with configs:", Object.keys(configs));
    const conn = new DataSource(configs);

    // Initialize entities
    const { SchemaBuilder } = await import("./query-builder");
    const schemaBuilder = new SchemaBuilder(conn);
    
    console.log("[DB] Syncing schemas from DataSource...");
    for (const EntityClass of this._entities) {
      if (EntityClass.entityName && EntityClass.schema) {
        try {
          await schemaBuilder.syncSchema(EntityClass.entityName, EntityClass.schema);
          console.log(`[DB] Synced schema for ${EntityClass.name || EntityClass.entityName}`);
        } catch (error) {
          console.error(`[DB] Failed to run sync query for ${EntityClass.name || EntityClass.entityName}:`, error);
          throw error;
        }
      }
    }

    return conn;
  }

  get client() {
    if (!DataSource.pool) {
      throw new Error("DataSource has not been initialized. Please call DataSource.initialize() first.");
    }
    return DataSource.pool.connect();
  }

  async query(sql: string, params?: unknown[]) {
    if (!DataSource.pool) {
      console.error("[DataSource] query() failed: DataSource.pool is undefined. Was initialize() called in this isolate?");
      throw new Error("DataSource has not been initialized. Please call DataSource.initialize() first.");
    }
    return DataSource.pool.query(sql, params);
  }

  createRepository<T extends BaseEntity>(EntityClass: EntityConstructor<T>): Repository<T> {
    class DynamicRepository extends Repository<T> {}
    return new DynamicRepository(EntityClass);
  }
}
