/**
 * `softDelete` names a column the entity declares, and the type holds it to a
 * nullable timestamp — NULL is what a live row carries.
 */
import { Entity } from "../src/index";

const cols = {
  id: { type: "UUID", primaryKey: true, notNull: true },
  name: { type: "TEXT", notNull: true },
  deletedAt: { type: "TIMESTAMPTZ", name: "deleted_at" },
  archivedAt: { type: "TIMESTAMPTZ", notNull: true },
  email: { type: "TEXT", unique: "live" },
} as const;

export const Ok = Entity.create("people", { columns: cols, softDelete: "deletedAt" });

// @ts-expect-error — a TEXT column cannot hold a deletion time
export const NotTimestamp = Entity.create("people", { columns: cols, softDelete: "name" });

// @ts-expect-error — notNull: a live row could not hold NULL
export const NotNullable = Entity.create("people", { columns: cols, softDelete: "archivedAt" });

// @ts-expect-error — not a column at all
export const Missing = Entity.create("people", { columns: cols, softDelete: "removedAt" });

export async function scopes(repo: import("../src/index").Repository<InstanceType<typeof Ok>>) {
  await repo.find({ withDeleted: true });
  await repo.find({ onlyDeleted: true });
  await repo.delete({ name: "x" }, { hard: true, onlyDeleted: true });
  await repo.update({ name: "x" }, { name: "y" }, { withDeleted: true });
  const { rows } = await repo.restore({ name: "x" });
  return rows;
}
