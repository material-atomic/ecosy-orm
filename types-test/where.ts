/**
 * `And` / `Or` from a caller's side.
 *
 * Every line here failed before the `NoInfer` on their parameters — not under
 * `exactOptionalPropertyTypes`, but always: the helpers could not be called at
 * all without writing the entity out by hand.
 */

import { And, Entity, Or, Repository, type FindWhereOptions } from "../src/index";

const UserEntity = Entity.create("users", {
  columns: {
    id: { type: "UUID", primaryKey: true, notNull: true },
    name: { type: "TEXT", notNull: true },
    age: { type: "INTEGER" },
  },
} as const);

type User = InstanceType<typeof UserEntity>;

class UserRepository extends Repository<User> {
  constructor() {
    super(UserEntity);
  }
}

const repo = new UserRepository();

export const nested = repo.find({ where: Or(And({ name: "a" }), { name: "b" }) });
export const flat = repo.find({ where: And({ name: "a" }, { age: 30 }) });

/* Still checked, which is the part that would have been easy to lose. */
// @ts-expect-error "nope" is not a column
export const unknownColumn = repo.find({ where: Or({ nope: 1 }) });
// @ts-expect-error age is a number
export const wrongType = repo.find({ where: And({ age: "old" }) });

/* No contextual type, so the entity has to be said once. */
export const standalone: FindWhereOptions<User> = And({ name: "a" });
