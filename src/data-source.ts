/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";

import type { PoolConfig } from "pg";
import { Pool } from "pg";
import { freeze } from "@ecosy/core/utilities";
import type { Entity as BaseEntity, EntityConstructor } from "./entity";
import { Repository } from "./repository";

export class DataSource {
  private static pool: Pool;
  private static _configs: PoolConfig;
  private static _entities: EntityConstructor<any>[] = [];

  constructor(configs?: PoolConfig) {
    if (configs) {
      if (!DataSource.pool) {
        DataSource._configs = freeze(configs) as PoolConfig;
        DataSource.pool = new Pool(DataSource._configs);
      }
    }
  }

  static entities(entities: EntityConstructor<any>[]) {
    this._entities = Array.from(new Set([...entities]));
    return this;
  }

  static async initialize(configs: PoolConfig) {
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
      throw new Error("DataSource has not been initialized. Please call DataSource.initialize() first.");
    }
    return DataSource.pool.query(sql, params);
  }

  createRepository<T extends BaseEntity>(EntityClass: EntityConstructor<T>): Repository<T> {
    class DynamicRepository extends Repository<T> {}
    return new DynamicRepository(EntityClass);
  }
}
