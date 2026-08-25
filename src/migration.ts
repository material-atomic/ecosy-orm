/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs/promises";
import path from "path";
import { DataSource } from "./data-source";

const connection = new DataSource();

async function checkConnection() {
  try {
    await connection.query("SELECT 1");
    return true;
  } catch (error) {
    console.error("[DB] Connection failed:", error);
    return false;
  }
}

async function ensureTrackingTable(tableName: string) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function runSqlFiles(dirPath: string, trackingTable: string) {
  await ensureTrackingTable(trackingTable);

  let files: string[];
  try {
    files = await fs.readdir(dirPath);
  } catch {
    // Thư mục không tồn tại thì bỏ qua
    return;
  }

  // Sắp xếp tên file (để chạy 001_, 002_ theo thứ tự)
  const sqlFiles = files.filter(f => f.endsWith(".sql")).sort();

  if (sqlFiles.length === 0) return;

  const result = await connection.query(`SELECT name FROM ${trackingTable}`);
  const executedFiles = new Set(result.rows.map(row => row.name));

  for (const file of sqlFiles) {
    if (!executedFiles.has(file)) {
      console.log(`[DB] Running ${trackingTable}: ${file}...`);
      const filePath = path.join(dirPath, file);
      const sql = await fs.readFile(filePath, "utf-8");

      try {
        await connection.query("BEGIN");
        await connection.query(sql);
        await connection.query(`INSERT INTO ${trackingTable} (name) VALUES ($1)`, [file]);
        await connection.query("COMMIT");
        console.log(`[DB] Successfully ran ${file}`);
      } catch (error) {
        await connection.query("ROLLBACK");
        console.error(`[DB] Failed to run ${file}:`, error);
        throw error; // Dừng tiến trình nếu có file bị lỗi
      }
    }
  }
}

import { SchemaBuilder } from "./query-builder";

export async function syncEntities(entityClasses: any[]) {
  console.log("[DB] Syncing schemas from entities...");
  const schemaBuilder = new SchemaBuilder(connection);
  for (const EntityClass of entityClasses) {
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
}

export async function initDatabase() {
  const isConnected = await checkConnection();
  if (!isConnected) return;

  console.log("[DB] Connected. Checking migrations...");
  const migrationsDir = path.join(process.cwd(), "src/core/db/migrations");
  await runSqlFiles(migrationsDir, "_migrations");

  console.log("[DB] Checking seeds...");
  const seedsDir = path.join(process.cwd(), "seeds");
  await runSqlFiles(seedsDir, "_seeds");
}
