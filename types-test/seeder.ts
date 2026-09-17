/**
 * `Seeder` from a caller's side: rows are typed by the entity, a key names its
 * columns, and it sits in `effects` of the class it seeds.
 */
import { Entity, Seeder, type EntityEffect } from "../src/index";

export class PlanEntity extends Entity.create("plans", {
  columns: {
    id: { type: "TEXT", primaryKey: true, notNull: true },
    name: { type: "TEXT", notNull: true },
    position: { type: "INTEGER", notNull: true, default: "0" },
  },
} as const) {
  static effects: EntityEffect<PlanEntity>[] = [
    Seeder(PlanEntity, [{ id: "free", name: "Free" }]),
    Seeder(PlanEntity, () => [{ id: "pro", name: "Pro", position: 2 }], { name: "seed-pro", when: "once" }),
  ];
}

// @ts-expect-error — position is a number
Seeder(PlanEntity, [{ id: "x", position: "first" }]);

// @ts-expect-error — the key names a column the entity does not have
Seeder(PlanEntity, [], { key: ["slug"] });

// @ts-expect-error — there is no upsert mode
Seeder(PlanEntity, [], { mode: "upsert" });
