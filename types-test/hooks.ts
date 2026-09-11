/**
 * Lifecycle hooks and effects, declared the way an application declares them —
 * under `exactOptionalPropertyTypes`, with `as const` configs.
 *
 * Type-level only. The runtime behaviour is covered against Postgres; what this
 * guards is that a subclass can write the hooks without a single cast.
 */

import { Entity, Repository, type EntityEffect } from "../src/index";

const configs = {
  columns: {
    id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
    name: { type: "TEXT", notNull: true },
    code: { type: "TEXT", notNull: true, unique: true },
    updatedAt: { type: "TIMESTAMPTZ", name: "updated_at", notNull: true, default: "now()" },
  },
} as const;

export class ProjectEntity extends Entity.create("projects", configs) {
  beforeInsert() {
    // `this` is the row, typed from the schema.
    this.code ??= crypto.randomUUID().slice(0, 8);
  }

  async beforeUpdate() {
    this.updatedAt = new Date().toISOString();
  }

  afterLoad() {
    const label: string = this.name;
    void label;
  }

  static effects: EntityEffect<ProjectEntity>[] = [
    {
      name: "backfill-code",
      when: "sync",
      run: ({ tx }) =>
        tx.query(`UPDATE projects SET code = left(gen_random_uuid()::text, 8) WHERE code IS NULL`),
    },
    {
      name: "rename-legacy",
      when: "once",
      async run({ repository }) {
        // The repository is typed for this entity: columns check, values check.
        const rows = await repository.find({ where: { name: "legacy" } });
        for (const row of rows) {
          await repository.update({ id: row.id }, { name: `legacy-${row.code}` });
        }
        // @ts-expect-error — not a column of this entity
        await repository.find({ where: { nope: 1 } });
      },
    },
  ];
}

export class ProjectRepository extends Repository<ProjectEntity> {
  constructor() {
    super(ProjectEntity);
  }
}

// @ts-expect-error — `when` is "sync" or "once", nothing else
export const wrongWhen: EntityEffect<ProjectEntity> = { name: "x", when: "boot", run: () => {} };

/* No type test for an async afterLoad, on purpose: a method returning a
   Promise is assignable where `void` is declared, so the compiler cannot
   refuse one. The guard is at run time — `hydrate` throws when afterLoad
   returns a thenable — and that is tested against a real database. */
